"""GPS-verified dealer check-in and check-out.

The check-in row is the evidence (where the salesman was, how far from the dealer, which rule applied). The
business record is the existing ``visits.Visit`` with its order lines and follow-up, created at check-out by the
existing ``record_visit`` service, so nothing about visits, orders or follow-ups is duplicated here.
"""
import uuid
from datetime import timedelta
from decimal import Decimal

from django.db import IntegrityError, transaction
from django.utils import timezone
from rest_framework.exceptions import NotFound

from apps.dealers.access import accessible_dealers
from apps.visits.models import Visit
from apps.visits.services import record_visit

from . import services
from .geo import haversine_m, valid_coordinate
from .models import BeatStop, DealerCheckIn, FieldAuditLog, FieldConfig
from .rules import FieldRuleError

G = DealerCheckIn.Geofence


def validated_fix(position, sent_at, now):
    """A check-in/out position, held to the same standard as a tracked GPS point, plus freshness: it must have
    been captured moments ago (after the device clock is corrected against the server's)."""
    lat, lng = round(float(position["latitude"]), 6), round(float(position["longitude"]), 6)
    accuracy = float(position["accuracy_m"])
    if not valid_coordinate(lat, lng):
        raise FieldRuleError("position_unusable", "That location reading is not valid. Try again.")
    if accuracy > services.tune("MAX_ACCURACY_M"):
        raise FieldRuleError("position_unusable", f"GPS accuracy is too poor (about ±{round(accuracy)} m). Move outdoors or near a window and try again.", accuracy_m=accuracy)
    skew = services.clock_skew_seconds(now, sent_at)
    captured = position["captured_at"] + timedelta(seconds=skew)
    if captured > now + timedelta(seconds=services.tune("MAX_FUTURE_S")) or captured < now - timedelta(seconds=services.tune("FRESH_FIX_S")):
        raise FieldRuleError("stale_position", "Your location reading is out of date. Wait for a fresh GPS reading and try again.")
    return {"latitude": lat, "longitude": lng, "accuracy_m": accuracy, "captured_at": captured}


def evaluate_geofence(dealer, fix, cfg) -> dict:
    """inside | outside | low_accuracy | no_dealer_location, with the numbers behind it.

    A reading too imprecise to tell is reported as low_accuracy, but only if it could still be inside: if the
    dealer is farther away than the reading's whole error circle, it is simply outside."""
    radius = dealer.geofence_radius_m or cfg.default_geofence_m
    if dealer.latitude is None or dealer.longitude is None or not valid_coordinate(dealer.latitude, dealer.longitude):
        return {"result": G.NO_DEALER_LOCATION, "distance_m": None, "radius_m": radius, "dealer_verified": False}
    distance = haversine_m(fix["latitude"], fix["longitude"], float(dealer.latitude), float(dealer.longitude))
    acc, max_acc = fix["accuracy_m"], services.tune("CHECKIN_MAX_ACCURACY_M")
    if acc > max_acc and distance - acc <= radius:
        result = G.LOW_ACCURACY
    elif distance <= radius:
        result = G.INSIDE
    else:
        result = G.OUTSIDE
    return {"result": result, "distance_m": int(round(distance)), "radius_m": radius, "dealer_verified": dealer.location_verified_at is not None}


def enforce(geo, cfg, dealer, fix, reason, *, checkout=False) -> str:
    """Applies the configured rule. Returns the override reason to store ('' when none was needed)."""
    res = geo["result"]
    if res in (G.INSIDE, G.NO_DEALER_LOCATION):
        return ""  # a dealer with no location cannot be verified; it is allowed and recorded as such
    facts = {"geofence": res, "distance_m": geo["distance_m"], "radius_m": geo["radius_m"], "accuracy_m": fix["accuracy_m"], "mode": cfg.geofence_mode}
    if res == G.OUTSIDE:
        msg = f"You are about {geo['distance_m']} m from {dealer.name}. You need to be within {geo['radius_m']} m."
    else:
        msg = f"GPS accuracy is ±{round(fix['accuracy_m'])} m, too imprecise to confirm you are at {dealer.name} (needs ±{services.tune('CHECKIN_MAX_ACCURACY_M')} m or better)."
    # Blocking applies to check-in. A salesman who has already left must still be able to close the visit, so
    # check-out is always allowed with an explanation, which is stored and flagged for review.
    if cfg.geofence_mode == FieldConfig.GeofenceMode.ENFORCE and not checkout:
        raise FieldRuleError(f"geofence_{res}", msg, can_override=False, **facts)
    if not (reason or "").strip():
        raise FieldRuleError("reason_required", msg + " Give a reason to continue; it will be flagged for review.", 400, can_override=True, **facts)
    return reason.strip()[:300]


def _require_duty(salesman, now):
    session = services.get_active_session(salesman, now)
    if session is None:
        raise FieldRuleError("not_on_duty", "Go on duty before checking in to a dealer.", 409)
    return session


def open_checkin(salesman):
    return DealerCheckIn.objects.select_related("dealer").filter(salesman=salesman, checked_out_at__isnull=True).first()


def check_in(user, salesman, *, dealer_id, position, sent_at=None, reason="", client_request_id=None, now=None):
    """Returns (checkin, created)."""
    now = now or timezone.now()
    if client_request_id:
        existing = DealerCheckIn.objects.filter(salesman=salesman, client_request_id=client_request_id).first()
        if existing:
            return existing, False
    dealer = accessible_dealers(user).filter(pk=dealer_id, is_archived=False).first()
    if dealer is None:
        raise NotFound("Dealer not found")  # inaccessible and nonexistent are indistinguishable, as elsewhere
    session = _require_duty(salesman, now)
    current = open_checkin(salesman)
    if current is not None:
        raise FieldRuleError("already_checked_in", f"You are still checked in at {current.dealer.name}. Check out first.", 409,
                             checkin_id=current.id, dealer_id=current.dealer_id)

    fix = validated_fix(position, sent_at, now)
    cfg = FieldConfig.get()
    geo = evaluate_geofence(dealer, fix, cfg)
    override = enforce(geo, cfg, dealer, fix, reason)
    stop = BeatStop.objects.filter(plan__salesman=salesman, plan__date=timezone.localdate(now), dealer=dealer).first()
    try:
        with transaction.atomic():
            checkin = DealerCheckIn.objects.create(
                salesman=salesman, dealer=dealer, session=session, stop=stop, checked_in_at=now,
                in_lat=Decimal(f"{fix['latitude']:.6f}"), in_lng=Decimal(f"{fix['longitude']:.6f}"), in_accuracy_m=fix["accuracy_m"],
                in_distance_m=geo["distance_m"], in_geofence=geo["result"], in_radius_m=geo["radius_m"],
                in_dealer_verified=geo["dealer_verified"], in_override_reason=override, client_request_id=client_request_id,
            )
            # The reading is also a valid tracked fix: keep the live position and route continuous.
            services.ingest_points(salesman, [{"client_point_id": uuid.uuid4(), "latitude": fix["latitude"], "longitude": fix["longitude"],
                                               "accuracy_m": fix["accuracy_m"], "captured_at": fix["captured_at"]}], now=now)
            if override:
                services.audit(user, FieldAuditLog.Action.CHECKIN_OVERRIDE, salesman=salesman, dealer_id=dealer.id, phase="in",
                               geofence=geo["result"], distance_m=geo["distance_m"], reason=override)
    except IntegrityError:
        again = DealerCheckIn.objects.filter(salesman=salesman, client_request_id=client_request_id).first() if client_request_id else None
        if again:
            return again, False
        current = open_checkin(salesman)
        raise FieldRuleError("already_checked_in", "You are already checked in at a dealer. Check out first.", 409, checkin_id=current.id if current else None)
    return checkin, True


def check_out(user, salesman, checkin_id, *, position, sent_at=None, outcome, notes="", has_order=False, order_items=None,
              followup=None, reason="", client_request_id=None, photo_ids=None, now=None):
    """Closes the visit and creates the matching ``Visit`` (orders, follow-up) through the existing service."""
    now = now or timezone.now()
    with transaction.atomic():
        checkin = DealerCheckIn.objects.select_for_update().select_related("dealer").filter(pk=checkin_id, salesman=salesman).first()
        if checkin is None:
            raise NotFound("Check-in not found")
        if checkin.checked_out_at is not None:
            if client_request_id and checkin.checkout_request_id == client_request_id:
                return checkin, False
            raise FieldRuleError("already_checked_out", "This visit is already checked out.", 409)

        fix = validated_fix(position, sent_at, now)
        cfg = FieldConfig.get()
        geo = evaluate_geofence(checkin.dealer, fix, cfg)
        override = enforce(geo, cfg, checkin.dealer, fix, reason, checkout=True)

        visit, _ = record_visit(user, {
            "dealer_id": checkin.dealer_id, "visited_at": checkin.checked_in_at, "latitude": checkin.in_lat, "longitude": checkin.in_lng,
            "notes": notes, "has_order": has_order, "order_items": order_items or [], "followup": followup, "client_request_id": client_request_id,
            "photo_ids": photo_ids or [],
        })
        Visit.objects.filter(pk=visit.pk).update(location_source="gps_checkin", location_captured_at=checkin.checked_in_at)

        checkin.checked_out_at = max(now, checkin.checked_in_at)
        checkin.out_lat, checkin.out_lng = Decimal(f"{fix['latitude']:.6f}"), Decimal(f"{fix['longitude']:.6f}")
        checkin.out_accuracy_m, checkin.out_distance_m, checkin.out_geofence = fix["accuracy_m"], geo["distance_m"], geo["result"]
        checkin.out_override_reason = override
        checkin.outcome, checkin.notes, checkin.visit = outcome, notes, visit
        checkin.checkout_request_id = client_request_id
        checkin.save()
        services.ingest_points(salesman, [{"client_point_id": uuid.uuid4(), "latitude": fix["latitude"], "longitude": fix["longitude"],
                                           "accuracy_m": fix["accuracy_m"], "captured_at": fix["captured_at"]}], now=now)
        if override:
            services.audit(user, FieldAuditLog.Action.CHECKIN_OVERRIDE, salesman=salesman, dealer_id=checkin.dealer_id, phase="out",
                           geofence=geo["result"], distance_m=geo["distance_m"], reason=override)
    return checkin, True


def checkin_payload(c: DealerCheckIn) -> dict:
    d = c.dealer
    return {
        "id": c.id, "dealer": {"id": d.id, "name": d.name, "shop_name": d.shop_name, "city": d.city, "phone": d.phone},
        "checked_in_at": c.checked_in_at, "checked_out_at": c.checked_out_at,
        "in_geofence": c.in_geofence, "in_distance_m": c.in_distance_m, "radius_m": c.in_radius_m,
        "in_override_reason": c.in_override_reason, "out_geofence": c.out_geofence, "out_distance_m": c.out_distance_m,
        "out_override_reason": c.out_override_reason, "outcome": c.outcome, "visit_id": c.visit_id, "flagged": c.flagged,
    }
