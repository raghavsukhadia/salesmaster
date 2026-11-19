"""Admin/manager field endpoints: live map, route history, nearby/reverse search, dealer location master.

Roles: admin and manager read the map and run searches (every sensitive read is audited); managers may also
set or verify dealer locations; configuration, forced session end and the audit log are admin-only.
"""
from datetime import datetime, time, timedelta

from django.conf import settings
from django.db import transaction
from django.db.models import Max, Q
from django.utils import timezone
from rest_framework.exceptions import NotFound, ValidationError
from rest_framework.response import Response
from rest_framework.views import APIView

from apps.accounts.models import Salesman, SalesmanTerritory
from apps.accounts.permissions import IsAdmin, IsManagement
from apps.dealers.models import Dealer
from apps.management.views import PAGE_SIZE, paginate, person

from . import beats, nearby, services
from .geo import valid_coordinate
from .models import DealerCheckIn, FieldAuditLog, FieldConfig, LocationPing, WorkSession
from .rules import RuleErrorMixin
from .serializers import BeatSaveSerializer, ConfigSerializer, DealerLocationSerializer, NearbyQuerySerializer

A = FieldAuditLog.Action
MAX_TRACK_POINTS = 3000


# --------------------------------------------------------------------------- live map

class LiveMapView(APIView):
    """Every active salesman with an honest tracking status. Off-duty salesmen are listed without any
    coordinates; on-duty ones carry their last fix with its age, and only ``live`` ones are marked live."""

    permission_classes = [IsManagement]
    ORDER = {"live": 0, "stale": 1, "lost": 2, "no_fix": 3, "off_duty": 4}

    def get(self, request):
        now = timezone.now()
        services.close_stale_sessions(now)
        active = {s.salesman_id: s for s in WorkSession.objects.filter(ended_at__isnull=True)}
        last_end = dict(
            WorkSession.objects.filter(ended_at__isnull=False).values_list("salesman_id").annotate(m=Max("ended_at"))
        )
        # Off duty, the map still shows where the salesman was last seen: the latest fix of their most recent session.
        last_seen = {}
        for s in WorkSession.objects.filter(ended_at__isnull=False, last_fix_at__isnull=False, last_lat__isnull=False).order_by("salesman_id", "-last_fix_at"):
            last_seen.setdefault(s.salesman_id, s)
        rows = []
        for sm in Salesman.objects.filter(is_active=True).select_related("user"):
            session = active.get(sm.id)
            st = services.tracking_status(session, now)
            fix = services.last_fix(session) if session else services.last_fix(last_seen.get(sm.id))
            rows.append({
                "id": sm.id, "name": person(sm), "phone": sm.phone_number,
                "on_duty": session is not None, **st,
                "session_started_at": session.started_at if session else None,
                "last_contact_at": session.last_contact_at if session else None,
                "last_duty_ended_at": None if session else last_end.get(sm.id),
                "last_fix": fix,
                "last_seen_s": max(0, int((now - fix["captured_at"]).total_seconds())) if fix else None,
            })
        rows.sort(key=lambda r: (self.ORDER[r["status"]], r["name"].lower()))
        counts = {k: 0 for k in self.ORDER}
        for r in rows:
            counts[r["status"]] += 1
        services.audit_throttled(request.user, A.MAP_VIEW, salesmen=len(rows), on_duty=sum(r["on_duty"] for r in rows))
        t = settings.FIELD_TRACKING
        return Response({
            "generated_at": now,
            "thresholds": {"live_s": t["LIVE_MAX_AGE_S"], "stale_s": t["STALE_MAX_AGE_S"]},
            "counts": counts,
            "salesmen": rows,
        })


class TrackView(APIView):
    """One salesman's recorded route for a local calendar day. Always audited."""

    permission_classes = [IsManagement]

    def get(self, request, pk):
        salesman = Salesman.objects.select_related("user").filter(pk=pk).first()
        if salesman is None:
            raise NotFound("Salesman not found")
        raw = request.query_params.get("date")
        try:
            day = datetime.strptime(raw, "%Y-%m-%d").date() if raw else timezone.localdate()
        except ValueError:
            raise ValidationError({"date": "Use YYYY-MM-DD"})
        tz = timezone.get_current_timezone()
        start = timezone.make_aware(datetime.combine(day, time.min), tz)
        end = start + timedelta(days=1)

        pings = LocationPing.objects.filter(salesman=salesman, captured_at__gte=start, captured_at__lt=end).order_by("captured_at", "id")
        total = pings.count()
        rows = list(pings.values_list("latitude", "longitude", "accuracy_m", "captured_at"))
        stride = -(-total // MAX_TRACK_POINTS) if total > MAX_TRACK_POINTS else 1
        sessions = WorkSession.objects.filter(salesman=salesman, started_at__lt=end).filter(
            Q(ended_at__isnull=True) | Q(ended_at__gte=start)
        ).order_by("started_at")
        services.audit(request.user, A.TRACK_VIEW, salesman=salesman, date=str(day), points=total)
        return Response({
            "salesman": {"id": salesman.id, "name": person(salesman)},
            "date": day,
            "total_points": total,
            "downsampled": stride > 1,
            "points": [
                {"latitude": float(la), "longitude": float(lo), "accuracy_m": acc, "captured_at": at}
                for la, lo, acc, at in rows[::stride]
            ],
            "sessions": [
                {"id": s.id, "started_at": s.started_at, "ended_at": s.ended_at, "end_reason": s.end_reason,
                 "ping_count": s.ping_count}
                for s in sessions
            ],
        })


class ForceEndSessionView(APIView):
    permission_classes = [IsAdmin]

    def post(self, request, pk):
        salesman = Salesman.objects.filter(pk=pk).first()
        if salesman is None:
            raise NotFound("Salesman not found")
        session = services.end_session(request.user, salesman, reason=WorkSession.EndReason.ADMIN)
        return Response({"ended": session is not None, "session_id": session.id if session else None})


# --------------------------------------------------------------------------- searches

class NearbyView(APIView):
    """Dealers near a map point, or near a salesman's current position (``salesman_id``)."""

    permission_classes = [IsManagement]

    def get(self, request):
        params = request.query_params
        if params.get("salesman_id"):
            salesman = Salesman.objects.filter(pk=params["salesman_id"] if params["salesman_id"].isdigit() else 0).first()
            if salesman is None:
                raise NotFound("Salesman not found")
            session = services.get_active_session(salesman)
            st = services.tracking_status(session)
            if st["status"] not in ("live", "stale"):
                raise ValidationError({"salesman_id": "This salesman has no recent location. Search from a point on the map instead."})
            data = {"latitude": float(session.last_lat), "longitude": float(session.last_lng),
                    "radius_km": params.get("radius_km", 5), "verified_only": params.get("verified_only", False)}
            q = NearbyQuerySerializer(data=data)
            q.is_valid(raise_exception=True)
            v = q.validated_data
            services.audit(request.user, A.REVERSE_SEARCH, salesman=salesman, kind="nearby_dealers", radius_km=v["radius_km"])
            out = nearby.nearby_dealers(request.user, v["latitude"], v["longitude"], v["radius_km"], verified_only=v["verified_only"])
            out["origin"].update({"salesman_id": salesman.id, **st, "captured_at": session.last_fix_at})
            return Response(out)
        q = NearbyQuerySerializer(data=params)
        q.is_valid(raise_exception=True)
        v = q.validated_data
        return Response(nearby.nearby_dealers(request.user, v["latitude"], v["longitude"], v["radius_km"], verified_only=v["verified_only"]))


class NearestSalesmenView(APIView):
    """Reverse search: who is closest to this dealer right now?"""

    permission_classes = [IsManagement]

    def get(self, request, pk):
        dealer = Dealer.objects.filter(pk=pk).first()
        if dealer is None:
            raise NotFound("Dealer not found")
        if dealer.latitude is None or dealer.longitude is None or not valid_coordinate(dealer.latitude, dealer.longitude):
            raise ValidationError({"dealer": "This dealer has no location yet. Set it in Dealer Locations first."})
        p = request.query_params
        try:
            limit = min(max(int(p.get("limit", 5)), 1), 25)
            max_km = float(p["max_km"]) if p.get("max_km") else None
        except ValueError:
            raise ValidationError("limit and max_km must be numbers")
        if max_km is not None and not 0 < max_km <= 500:
            raise ValidationError({"max_km": "Must be between 0 and 500"})
        include_stale = p.get("include_stale", "").lower() in ("1", "true", "yes")
        out = nearby.nearest_salesmen(dealer, limit=limit, max_km=max_km, include_stale=include_stale)
        services.audit(request.user, A.REVERSE_SEARCH, dealer_id=dealer.id, kind="nearest_salesmen",
                       include_stale=include_stale, results=len(out["results"]))
        return Response(out)


# --------------------------------------------------------------------------- dealer location master

class DealerMapView(APIView):
    """All saved dealer pins, independent of salesman selection, radius and list pagination."""

    permission_classes = [IsManagement]

    def get(self, request):
        base = Dealer.objects.filter(is_archived=False)
        located = base.filter(
            latitude__gte=-90, latitude__lte=90, longitude__gte=-180, longitude__lte=180,
        ).exclude(latitude=0, longitude=0)
        results = [{
            "id": row["id"], "name": row["name"], "shop_name": row["shop_name"],
            "phone": row["phone"], "address": row["address"], "city": row["city"], "state": row["state"],
            "latitude": float(row["latitude"]), "longitude": float(row["longitude"]),
            "location_verified": row["location_verified_at"] is not None,
        } for row in located.order_by("id").values(
            "id", "name", "shop_name", "phone", "address", "city", "state", "latitude", "longitude", "location_verified_at",
        )]
        total = base.count()
        return Response({"total": total, "located": len(results), "missing_location": total - len(results), "results": results})


def location_payload(d: Dealer) -> dict:
    return {
        "id": d.id, "name": d.name,
        "latitude": float(d.latitude) if d.latitude is not None else None,
        "longitude": float(d.longitude) if d.longitude is not None else None,
        "source": d.location_source, "accuracy_m": d.location_accuracy_m,
        "verified": d.location_verified_at is not None, "verified_at": d.location_verified_at,
        "verified_by": d.location_verified_by.get_username() if d.location_verified_by else None,
        "geofence_radius_m": d.geofence_radius_m,
    }


def location_history(dealer_id: int) -> list[dict]:
    """Every capture, change and verification of a dealer's shop location, newest first: who, when, and where."""
    out = []
    rows = FieldAuditLog.objects.filter(dealer_id=dealer_id, action__in=[A.DEALER_LOCATION_SET, A.DEALER_LOCATION_VERIFY]).select_related("actor")
    for r in rows[:100]:
        d = r.detail or {}
        pos = d.get("after") or d  # a set stores the new position under "after"; a verify stores it at the top level
        lat, lng = pos.get("latitude"), pos.get("longitude")
        if r.action == A.DEALER_LOCATION_VERIFY:
            event = "verified"
        elif d.get("via") in ("new_dealer_form", "visit", "checkin"):
            event = "captured"
        else:
            event = "updated"
        out.append({
            "id": r.id, "at": r.created_at, "event": event,
            "by": (r.actor.get_full_name() or r.actor.get_username()) if r.actor else r.actor_username or "System",
            "by_role": getattr(r.actor, "role", "") if r.actor else "",
            "latitude": float(lat) if lat not in (None, "") else None,
            "longitude": float(lng) if lng not in (None, "") else None,
            "accuracy_m": pos.get("accuracy_m"),
            "source": pos.get("source", ""),
        })
    return out


def _has_location(d: Dealer) -> bool:
    return d.latitude is not None and d.longitude is not None and valid_coordinate(d.latitude, d.longitude)


class DealerLocationView(APIView):
    permission_classes = [IsManagement]

    def get(self, request, pk):
        d = Dealer.objects.select_related("location_verified_by").filter(pk=pk).first()
        if d is None:
            raise NotFound("Dealer not found")
        return Response({**location_payload(d), "history": location_history(d.id)})

    def put(self, request, pk):
        s = DealerLocationSerializer(data=request.data)
        s.is_valid(raise_exception=True)
        v = s.validated_data
        with transaction.atomic():
            d = Dealer.objects.select_for_update().filter(pk=pk).first()
            if d is None:
                raise NotFound("Dealer not found")
            before = {"latitude": d.latitude, "longitude": d.longitude, "verified": d.location_verified_at is not None}
            d.latitude, d.longitude = round(v["latitude"], 6), round(v["longitude"], 6)
            d.location_source = v["source"]
            d.location_accuracy_m = v.get("accuracy_m")
            if "geofence_radius_m" in v:
                d.geofence_radius_m = v["geofence_radius_m"]
            # Moving a pin always invalidates an earlier verification; the caller re-asserts it explicitly.
            d.location_verified_at = timezone.now() if v["verified"] else None
            d.location_verified_by = request.user if v["verified"] else None
            d.save(update_fields=["latitude", "longitude", "location_source", "location_accuracy_m", "geofence_radius_m",
                                  "location_verified_at", "location_verified_by"])
            services.audit(request.user, A.DEALER_LOCATION_SET, dealer_id=d.id, before=before,
                           after={"latitude": d.latitude, "longitude": d.longitude, "verified": v["verified"], "source": v["source"]})
        d.refresh_from_db()
        return Response(location_payload(d))


class DealerLocationVerifyView(APIView):
    """Marks the coordinates already on file as verified, without changing them."""

    permission_classes = [IsManagement]

    def post(self, request, pk):
        with transaction.atomic():
            d = Dealer.objects.select_for_update().filter(pk=pk).first()
            if d is None:
                raise NotFound("Dealer not found")
            if not _has_location(d):
                raise ValidationError({"dealer": "This dealer has no usable location to verify. Set one first."})
            d.location_verified_at = timezone.now()
            d.location_verified_by = request.user
            d.save(update_fields=["location_verified_at", "location_verified_by"])
            services.audit(request.user, A.DEALER_LOCATION_VERIFY, dealer_id=d.id, latitude=d.latitude, longitude=d.longitude)
        d.refresh_from_db()
        return Response(location_payload(d))


class DealerLocationsListView(APIView):
    """The location master: every dealer with its coordinates, verification state, territory and contact."""

    permission_classes = [IsManagement]

    def get(self, request):
        p = request.query_params
        base = Dealer.objects.filter(is_archived=False)
        located = base.filter(latitude__isnull=False, longitude__isnull=False).exclude(latitude=0, longitude=0)
        verified = located.filter(location_verified_at__isnull=False)
        summary = {"total": base.count(), "verified": verified.count(),
                   "unverified": located.count() - verified.count(), "missing": base.count() - located.count()}

        qs = base.select_related("status", "location_verified_by").prefetch_related("contacts")
        mode = p.get("status", "all")
        if mode == "missing":
            qs = qs.exclude(pk__in=located.values("pk"))
        elif mode == "unverified":
            qs = qs.filter(pk__in=located.filter(location_verified_at__isnull=True).values("pk"))
        elif mode == "verified":
            qs = qs.filter(pk__in=verified.values("pk"))
        if p.get("state"):
            qs = qs.filter(state__iexact=p["state"])
        if p.get("city"):
            qs = qs.filter(city__icontains=p["city"])
        if p.get("q"):
            q = p["q"].strip()
            qs = qs.filter(Q(name__icontains=q) | Q(shop_name__icontains=q) | Q(phone__icontains=q) | Q(city__icontains=q) | Q(pincode__icontains=q))
        qs = qs.order_by("name", "id")
        count, page = paginate(request, qs)

        territories = {}
        for t in SalesmanTerritory.objects.select_related("salesman__user"):
            territories.setdefault(t.state.lower(), []).append((t.city.lower(), person(t.salesman)))
        rows = []
        for d in page:
            contact = next(iter(d.contacts.all()), None)
            covered = sorted({name for city, name in territories.get(d.state.lower(), []) if not city or city == d.city.lower()})
            rows.append({
                **location_payload(d),
                "has_location": _has_location(d),
                "address": d.address, "city": d.city, "state": d.state, "pincode": d.pincode,
                "phone": d.phone, "territory": {"state": d.state, "city": d.city, "covered_by": covered},
                "contact": {"name": contact.name, "phone": contact.phone} if contact else None,
            })
        return Response({"summary": summary, "count": count, "page_size": PAGE_SIZE, "results": rows})


# --------------------------------------------------------------------------- config & audit (admin)

class ConfigView(APIView):
    def get_permissions(self):
        return [(IsAdmin if self.request.method == "PUT" else IsManagement)()]

    def get(self, request):
        return Response(self._payload())

    def put(self, request):
        cfg = FieldConfig.get()
        s = ConfigSerializer(cfg, data=request.data)
        s.is_valid(raise_exception=True)
        before = ConfigSerializer(cfg).data
        cfg = s.save(updated_by=request.user)
        after = ConfigSerializer(cfg).data
        changed = {k: {"from": before[k], "to": after[k]} for k in after if before[k] != after[k]}
        if changed:
            services.audit(request.user, A.CONFIG_CHANGE, changes=changed)
        return Response(self._payload())

    @staticmethod
    def _payload():
        cfg = FieldConfig.get()
        t = settings.FIELD_TRACKING
        return {**ConfigSerializer(cfg).data, "updated_at": cfg.updated_at, "radii_km": list(t["NEARBY_RADII_KM"]),
                "live_max_age_s": t["LIVE_MAX_AGE_S"], "stale_max_age_s": t["STALE_MAX_AGE_S"]}


class AuditLogView(APIView):
    permission_classes = [IsAdmin]

    def get(self, request):
        p = request.query_params
        qs = FieldAuditLog.objects.select_related("salesman__user")
        if p.get("action"):
            qs = qs.filter(action=p["action"])
        if p.get("salesman_id", "").isdigit():
            qs = qs.filter(salesman_id=p["salesman_id"])
        count, page = paginate(request, qs)
        return Response({"count": count, "results": [
            {"id": a.id, "at": a.created_at, "actor": a.actor_username or "system", "action": a.action,
             "salesman": person(a.salesman) if a.salesman else None, "dealer_id": a.dealer_id, "detail": a.detail}
            for a in page
        ]})


# --------------------------------------------------------------------------- beat planning & check-in log

def _salesman_or_404(raw):
    if raw is None or not str(raw).isdigit():
        raise ValidationError({"salesman_id": "salesman_id is required"})
    s = Salesman.objects.select_related("user").filter(pk=int(raw)).first()
    if s is None:
        raise NotFound("Salesman not found")
    return s


def _date_param(raw):
    try:
        return datetime.strptime(raw, "%Y-%m-%d").date() if raw else timezone.localdate()
    except ValueError:
        raise ValidationError({"date": "Use YYYY-MM-DD"})


class BeatPlanView(RuleErrorMixin, APIView):
    permission_classes = [IsManagement]

    def get(self, request):
        salesman = _salesman_or_404(request.query_params.get("salesman_id"))
        day = _date_param(request.query_params.get("date"))
        return Response({"salesman": {"id": salesman.id, "name": person(salesman)}, "date": day,
                         "plan": beats.plan_payload(beats.get_plan(salesman, day))})

    def put(self, request):
        s = BeatSaveSerializer(data=request.data)
        s.is_valid(raise_exception=True)
        v = s.validated_data
        salesman = _salesman_or_404(v["salesman_id"])
        if not salesman.is_active:
            raise ValidationError({"salesman_id": "This salesman is not active"})
        plan = beats.save_plan(request.user, salesman, v["date"], v.get("note", ""), v["stops"])
        return Response({"salesman": {"id": salesman.id, "name": person(salesman)}, "date": v["date"], "plan": beats.plan_payload(plan)})

    def delete(self, request):
        salesman = _salesman_or_404(request.query_params.get("salesman_id"))
        day = _date_param(request.query_params.get("date"))
        return Response({"deleted": beats.delete_plan(request.user, salesman, day)})


class BeatDealerOptionsView(APIView):
    """Dealers a salesman can actually visit (owned or granted), for the beat editor's picker."""

    permission_classes = [IsManagement]

    def get(self, request):
        from apps.dealers.access import accessible_dealers

        salesman = _salesman_or_404(request.query_params.get("salesman_id"))
        qs = accessible_dealers(salesman.user).filter(is_archived=False)
        q = request.query_params.get("q", "").strip()
        if q:
            qs = qs.filter(Q(name__icontains=q) | Q(shop_name__icontains=q) | Q(city__icontains=q) | Q(phone__icontains=q))
        return Response([{
            "id": d.id, "name": d.name, "shop_name": d.shop_name, "city": d.city, "state": d.state,
            "latitude": float(d.latitude) if d.latitude is not None else None,
            "longitude": float(d.longitude) if d.longitude is not None else None,
            "location_verified": d.location_verified_at is not None,
        } for d in qs.order_by("name")[:50]])


class CheckInListView(APIView):
    """Verified visits for a day with the evidence: distance, geofence result, overrides, outcome."""

    permission_classes = [IsManagement]

    def get(self, request):
        p = request.query_params
        day = _date_param(p.get("date"))
        tz = timezone.get_current_timezone()
        start = timezone.make_aware(datetime.combine(day, time.min), tz)
        base = DealerCheckIn.objects.filter(checked_in_at__gte=start, checked_in_at__lt=start + timedelta(days=1))
        if p.get("salesman_id", "").isdigit():
            base = base.filter(salesman_id=p["salesman_id"])
        flagged_q = ~Q(in_geofence="inside") | (~Q(out_geofence="") & ~Q(out_geofence="inside"))
        qs = base.select_related("salesman__user", "dealer")
        if p.get("flagged") in ("1", "true"):
            qs = qs.filter(flagged_q)
        qs = qs.order_by("-checked_in_at", "-id")
        count, page = paginate(request, qs)
        now = timezone.now()
        return Response({
            "date": day,
            "summary": {"total": base.count(), "open": base.filter(checked_out_at__isnull=True).count(),
                        "flagged": base.filter(flagged_q).count(), "verified_inside": base.filter(in_geofence="inside").count()},
            "count": count,
            "results": [{
                "id": c.id, "salesman": person(c.salesman), "dealer": {"id": c.dealer_id, "name": c.dealer.name, "city": c.dealer.city},
                "checked_in_at": c.checked_in_at, "checked_out_at": c.checked_out_at,
                "minutes": int(((c.checked_out_at or now) - c.checked_in_at).total_seconds() // 60),
                "in_geofence": c.in_geofence, "in_distance_m": c.in_distance_m, "radius_m": c.in_radius_m, "in_override_reason": c.in_override_reason,
                "out_geofence": c.out_geofence, "out_distance_m": c.out_distance_m, "out_override_reason": c.out_override_reason,
                "outcome": c.outcome, "visit_id": c.visit_id, "flagged": c.flagged,
            } for c in page],
        })
