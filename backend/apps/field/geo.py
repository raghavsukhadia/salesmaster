"""Geospatial helpers: straight-line distance and an index-friendly bounding-box prefilter.

Everything here is *straight-line* (great-circle) distance. Driving distance needs a routing provider and
is never inferred from these numbers; API payloads carry ``driving_m: null`` to say so explicitly.

Why not PostGIS: local dev and tests run on SQLite. ``Dealer`` has a composite btree index on
(latitude, longitude); the bounding box turns "within R km" into a range scan on that index and the exact
haversine check then trims the corners. That is comfortably fast into the hundreds of thousands of dealers.
Beyond that, move to PostGIS (geography column + GiST) behind ``dealers_within`` without touching callers.
"""
import math

from django.db.models import Q

EARTH_RADIUS_M = 6_371_008.8  # IUGG mean Earth radius
_PAD_DEG = 1e-5  # ~1 m; absorbs Decimal(9,6) rounding so the box is always a superset of the circle


def valid_coordinate(lat, lng) -> bool:
    """In range, finite, and not (0, 0) - "Null Island" is what a failed geocode or unset field looks like."""
    try:
        lat, lng = float(lat), float(lng)
    except (TypeError, ValueError):
        return False
    if not (math.isfinite(lat) and math.isfinite(lng)):
        return False
    if not (-90 <= lat <= 90 and -180 <= lng <= 180):
        return False
    return not (lat == 0 and lng == 0)


def haversine_m(lat1, lng1, lat2, lng2) -> float:
    p1, p2 = math.radians(lat1), math.radians(lat2)
    a = math.sin((p2 - p1) / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(math.radians(lng2 - lng1) / 2) ** 2
    return 2 * EARTH_RADIUS_M * math.asin(min(1.0, math.sqrt(a)))


def bounding_box(lat, lng, radius_m):
    """(min_lat, max_lat, [(min_lng, max_lng), ...]) guaranteed to contain the circle.

    Two longitude ranges when the circle crosses the antimeridian; the full range when it contains a pole.
    """
    ang = radius_m / EARTH_RADIUS_M
    dlat = math.degrees(ang)
    min_lat, max_lat = lat - dlat, lat + dlat
    if min_lat <= -90 or max_lat >= 90:
        return max(min_lat, -90.0) - _PAD_DEG, min(max_lat, 90.0) + _PAD_DEG, [(-180.0, 180.0)]
    dlng = math.degrees(math.asin(min(1.0, math.sin(ang) / math.cos(math.radians(lat))))) + _PAD_DEG
    lo, hi = lng - dlng, lng + dlng
    if lo < -180:
        ranges = [(lo + 360, 180.0), (-180.0, hi)]
    elif hi > 180:
        ranges = [(lo, 180.0), (-180.0, hi - 360)]
    else:
        ranges = [(lo, hi)]
    return min_lat - _PAD_DEG, max_lat + _PAD_DEG, ranges


def box_filter(min_lat, max_lat, lng_ranges, lat_field="latitude", lng_field="longitude") -> Q:
    lng = Q()
    for lo, hi in lng_ranges:
        lng |= Q(**{f"{lng_field}__gte": lo, f"{lng_field}__lte": hi})
    return Q(**{f"{lat_field}__gte": min_lat, f"{lat_field}__lte": max_lat}) & lng


def dealers_within(qs, lat, lng, radius_m):
    """[(dealer, distance_m)] nearest first, for dealers in ``qs`` within ``radius_m`` of (lat, lng).

    Dealers with no coordinates, or the (0, 0) placeholder, are never returned. Callers slice for paging.
    """
    min_lat, max_lat, lng_ranges = bounding_box(lat, lng, radius_m)
    rows = (
        qs.filter(latitude__isnull=False, longitude__isnull=False)
        .exclude(latitude=0, longitude=0)
        .filter(box_filter(min_lat, max_lat, lng_ranges))
    )
    found = []
    for d in rows:
        dist = haversine_m(lat, lng, float(d.latitude), float(d.longitude))
        if dist <= radius_m:
            found.append((d, dist))
    found.sort(key=lambda pair: (pair[1], pair[0].id))
    return found
