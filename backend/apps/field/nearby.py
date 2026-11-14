"""Nearby dealer search and the reverse search (nearest salesmen to a dealer).

Distances are straight-line only. Every row carries ``straight_line_m`` and ``driving_m: null`` so no
consumer can mistake one for the other; the payload-level ``distance_basis`` repeats it.
"""
from django.conf import settings
from django.utils import timezone

from apps.dealers.access import accessible_dealers
from apps.dealers.models import Dealer, DealerOwnershipHistory
from apps.management.views import person

from .geo import dealers_within, haversine_m
from .models import WorkSession
from .services import accuracy_quality, last_fix, tracking_status

DISTANCE_NOTE = (
    "Distances are straight-line (as the crow flies), not driving distance. "
    "Open a row in a maps app for actual road distance and time."
)


def allowed_radii():
    return tuple(settings.FIELD_TRACKING["NEARBY_RADII_KM"])


def _distance(dist_m):
    return {"straight_line_m": int(round(dist_m)), "driving_m": None}


def nearby_dealers(user, lat, lng, radius_km, *, verified_only=False):
    """Dealers the user may see within radius_km of (lat, lng), nearest first."""
    qs = (Dealer.objects.all() if user.is_management else accessible_dealers(user)).filter(is_archived=False)
    if verified_only:
        qs = qs.filter(location_verified_at__isnull=False)
    found = dealers_within(qs.select_related("status"), lat, lng, radius_km * 1000)
    limit = settings.FIELD_TRACKING["NEARBY_LIMIT"]
    shown = found[:limit]

    owners = {}
    if user.is_management and shown:
        owners = {
            o.dealer_id: o.salesman
            for o in DealerOwnershipHistory.objects.filter(
                dealer_id__in=[d.id for d, _ in shown], ended_at__isnull=True
            ).select_related("salesman__user")
        }
    rows = []
    for d, dist in shown:
        row = {
            "id": d.id, "name": d.name, "shop_name": d.shop_name, "phone": d.phone,
            "city": d.city, "state": d.state,
            "latitude": float(d.latitude), "longitude": float(d.longitude),
            "location_verified": d.location_verified_at is not None,
            **_distance(dist),
        }
        if user.is_management:
            owner = owners.get(d.id)
            row.update({
                "status": d.status.name if d.status else "",
                "owner": {"id": owner.id, "name": person(owner)} if owner else None,
                "last_visit_at": d.last_visit_at,
                "location_source": d.location_source,
            })
        rows.append(row)
    return {
        "origin": {"latitude": lat, "longitude": lng},
        "radius_km": radius_km,
        "distance_basis": "straight_line",
        "distance_note": DISTANCE_NOTE,
        "total": len(found),
        "truncated": len(found) > limit,
        "results": rows,
    }


def nearest_salesmen(dealer, *, limit=5, max_km=None, include_stale=False, now=None):
    """On-duty salesmen ranked by straight-line distance to ``dealer``.

    A stale or lost position is not "available nearby": it is excluded unless ``include_stale`` is set, and
    then every row still states its age and ``is_live``.
    """
    now = now or timezone.now()
    d_lat, d_lng = float(dealer.latitude), float(dealer.longitude)
    owner_id = (
        DealerOwnershipHistory.objects.filter(dealer=dealer, ended_at__isnull=True).values_list("salesman_id", flat=True).first()
    )
    sessions = (
        WorkSession.objects.filter(ended_at__isnull=True, last_fix_at__isnull=False, salesman__is_active=True)
        .select_related("salesman__user")
    )
    rows = []
    for s in sessions:
        st = tracking_status(s, now)
        if st["status"] != "live" and not (include_stale and st["status"] in ("stale", "lost")):
            continue
        dist = haversine_m(d_lat, d_lng, float(s.last_lat), float(s.last_lng))
        if max_km is not None and dist > max_km * 1000:
            continue
        fix = last_fix(s)
        rows.append({
            "salesman_id": s.salesman_id, "name": person(s.salesman), "phone": s.salesman.phone_number,
            "is_owner": s.salesman_id == owner_id,
            "status": st["status"], "is_live": st["is_live"], "age_s": st["age_s"],
            "latitude": fix["latitude"], "longitude": fix["longitude"],
            "accuracy_m": fix["accuracy_m"], "quality": accuracy_quality(fix["accuracy_m"]),
            "captured_at": fix["captured_at"],
            **_distance(dist),
        })
    rows.sort(key=lambda r: (r["straight_line_m"], r["salesman_id"]))
    return {
        "dealer": {"id": dealer.id, "name": dealer.name, "latitude": d_lat, "longitude": d_lng,
                   "location_verified": dealer.location_verified_at is not None},
        "distance_basis": "straight_line",
        "distance_note": DISTANCE_NOTE,
        "include_stale": include_stale,
        "results": rows[:limit],
    }
