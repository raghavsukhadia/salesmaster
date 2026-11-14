"""Daily beat plans: which dealers a salesman is meant to visit on a date, in order."""
from django.db import transaction
from django.utils import timezone

from apps.dealers.access import accessible_dealers
from apps.dealers.models import Dealer

from . import services
from .models import BeatPlan, BeatStop, DealerCheckIn, FieldAuditLog
from .rules import FieldRuleError

MAX_STOPS = 60


def stop_status(stop, checkins) -> str:
    """planned | in_progress | visited | skipped, derived from the stop's check-ins (never stored twice)."""
    mine = [c for c in checkins if c.stop_id == stop.id]
    if any(c.checked_out_at is None for c in mine):
        return "in_progress"
    if mine:
        return "visited"
    return "skipped" if stop.skipped_at else "planned"


def plan_payload(plan: BeatPlan | None) -> dict | None:
    if plan is None:
        return None
    stops = list(plan.stops.select_related("dealer", "dealer__status"))
    checkins = list(DealerCheckIn.objects.filter(stop__in=stops).order_by("checked_in_at"))
    by_stop = {}
    for c in checkins:
        by_stop[c.stop_id] = c
    rows = []
    for s in stops:
        d, c = s.dealer, by_stop.get(s.id)
        rows.append({
            "id": s.id, "sequence": s.sequence, "note": s.note, "status": stop_status(s, checkins),
            "skipped_reason": s.skipped_reason,
            "dealer": {"id": d.id, "name": d.name, "shop_name": d.shop_name, "city": d.city, "state": d.state, "phone": d.phone,
                       "latitude": float(d.latitude) if d.latitude is not None else None,
                       "longitude": float(d.longitude) if d.longitude is not None else None,
                       "location_verified": d.location_verified_at is not None},
            "checkin_id": c.id if c else None, "checked_in_at": c.checked_in_at if c else None,
            "checked_out_at": c.checked_out_at if c else None, "in_geofence": c.in_geofence if c else "", "outcome": c.outcome if c else "",
        })
    counts = {k: sum(1 for r in rows if r["status"] == k) for k in ("planned", "in_progress", "visited", "skipped")}
    return {"id": plan.id, "date": plan.date, "note": plan.note, "salesman_id": plan.salesman_id, "stops": rows, "counts": counts, "total": len(rows)}


def get_plan(salesman, date):
    return BeatPlan.objects.filter(salesman=salesman, date=date).first()


def save_plan(user, salesman, date, note, stops):
    """Create or update the plan for (salesman, date). ``stops`` is the full ordered list [{dealer_id, note}].

    Stops are matched by dealer so reordering keeps a stop's check-ins; a stop that already has a visit cannot
    be removed. Only dealers the salesman can actually access may be planned: they could not check in otherwise."""
    if date < timezone.localdate():
        raise FieldRuleError("past_date", "Beat plans cannot be changed for a past date.", 400)
    ids = [s["dealer_id"] for s in stops]
    if len(ids) > MAX_STOPS:
        raise FieldRuleError("too_many_stops", f"A beat can have at most {MAX_STOPS} stops.", 400)
    if len(set(ids)) != len(ids):
        raise FieldRuleError("duplicate_dealer", "A dealer can appear only once in a beat.", 400)
    allowed = set(accessible_dealers(salesman.user).filter(pk__in=ids, is_archived=False).values_list("pk", flat=True))
    bad = [i for i in ids if i not in allowed]
    if bad:
        names = list(Dealer.objects.filter(pk__in=bad).values_list("name", flat=True)) or [f"#{i}" for i in bad]
        raise FieldRuleError("dealer_not_available", "These dealers are not available to this salesman (not owned, no access grant, or archived): " + ", ".join(names), 400, dealer_ids=bad)

    with transaction.atomic():
        plan, created = BeatPlan.objects.select_for_update().get_or_create(salesman=salesman, date=date, defaults={"created_by": user, "note": note})
        existing = {s.dealer_id: s for s in plan.stops.all()}
        keep = set(ids)
        for dealer_id, stop in existing.items():
            if dealer_id not in keep and stop.checkins.exists():
                raise FieldRuleError("stop_has_visit", f"{stop.dealer.name} already has a check-in on this beat and cannot be removed.", 400)
        BeatStop.objects.filter(plan=plan).exclude(dealer_id__in=keep).delete()
        for seq, item in enumerate(stops, start=1):
            stop = existing.get(item["dealer_id"])
            if stop:
                stop.sequence, stop.note = seq, item.get("note", "")
                stop.save(update_fields=["sequence", "note"])
            else:
                BeatStop.objects.create(plan=plan, dealer_id=item["dealer_id"], sequence=seq, note=item.get("note", ""))
        plan.note = note
        plan.save(update_fields=["note", "updated_at"])
        services.audit(user, FieldAuditLog.Action.BEAT_SAVE, salesman=salesman, date=str(date), stops=len(ids), created=created)
    return plan


def delete_plan(user, salesman, date) -> bool:
    plan = get_plan(salesman, date)
    if plan is None:
        return False
    if DealerCheckIn.objects.filter(stop__plan=plan).exists():
        raise FieldRuleError("plan_has_visits", "This beat already has check-ins and cannot be deleted.", 400)
    plan.delete()
    services.audit(user, FieldAuditLog.Action.BEAT_SAVE, salesman=salesman, date=str(date), deleted=True)
    return True


def skip_stop(salesman, stop_id, reason):
    stop = BeatStop.objects.select_related("plan", "dealer").filter(pk=stop_id, plan__salesman=salesman).first()
    if stop is None or stop.plan.date != timezone.localdate():
        raise FieldRuleError("not_found", "That stop is not on today's beat.", 404)
    if stop.checkins.exists():
        raise FieldRuleError("stop_has_visit", "You have already visited this dealer.", 409)
    if not (reason or "").strip():
        raise FieldRuleError("reason_required", "Say why you are skipping this dealer.", 400)
    stop.skipped_at, stop.skipped_reason = timezone.now(), reason.strip()[:200]
    stop.save(update_fields=["skipped_at", "skipped_reason"])
    return stop
