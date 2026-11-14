import math
import random

import pytest
from django.db import connection

from apps.dealers.models import Dealer
from apps.field.geo import bounding_box, box_filter, dealers_within, haversine_m, valid_coordinate
from apps.field.helpers import KM, PUNE, make_dealer

pytestmark = pytest.mark.django_db


def test_haversine_known_distances():
    # One degree of latitude is ~111.195 km on the IUGG mean sphere.
    assert haversine_m(0, 10, 1, 10) == pytest.approx(111_195, rel=1e-4)
    assert haversine_m(*PUNE, *PUNE) == 0
    # Mumbai -> Pune is ~120 km as the crow flies (road distance is ~150 km: they must not be confused).
    assert haversine_m(19.0760, 72.8777, 18.5204, 73.8567) == pytest.approx(120_000, rel=0.03)
    # Across the antimeridian the short way is used.
    assert haversine_m(0, 179.9, 0, -179.9) == pytest.approx(22_239, rel=1e-3)


@pytest.mark.parametrize("lat,lng,ok", [
    (18.5, 73.8, True), (-90, 180, True), (90.0001, 0, False), (0, 180.5, False),
    (0, 0, False),  # Null Island: what an unset or failed-geocode coordinate looks like
    (float("nan"), 1, False), (1, float("inf"), False), (None, 1, False), ("x", 1, False),
])
def test_valid_coordinate(lat, lng, ok):
    assert valid_coordinate(lat, lng) is ok


@pytest.mark.parametrize("lat,lng", [(18.5, 73.8), (0.1, 179.99), (0.1, -179.99), (89.9, 10), (-89.95, -40), (60, 0)])
def test_bounding_box_always_contains_the_circle(lat, lng):
    rng = random.Random(7)
    for radius in (1_000, 5_000, 20_000, 200_000):
        min_lat, max_lat, ranges = bounding_box(lat, lng, radius)
        for _ in range(400):
            # random point exactly within the circle, found by walking a bearing
            bearing, dist = rng.uniform(0, 2 * math.pi), radius * math.sqrt(rng.random())
            ang, p1, l1 = dist / 6_371_008.8, math.radians(lat), math.radians(lng)
            p2 = math.asin(math.sin(p1) * math.cos(ang) + math.cos(p1) * math.sin(ang) * math.cos(bearing))
            l2 = l1 + math.atan2(math.sin(bearing) * math.sin(ang) * math.cos(p1), math.cos(ang) - math.sin(p1) * math.sin(p2))
            plat, plng = math.degrees(p2), (math.degrees(l2) + 540) % 360 - 180
            assert min_lat <= plat <= max_lat
            assert any(lo <= plng <= hi for lo, hi in ranges), (lat, lng, radius, plat, plng, ranges)


def test_antimeridian_and_pole_boxes():
    _, _, ranges = bounding_box(0, 179.99, 20_000)
    assert len(ranges) == 2 and ranges[0][1] == 180 and ranges[1][0] == -180
    _, _, ranges = bounding_box(89.99, 0, 50_000)
    assert ranges == [(-180.0, 180.0)]


def test_dealers_within_matches_brute_force():
    rng = random.Random(42)
    rows = []
    for i in range(300):
        lat, lng = PUNE[0] + rng.uniform(-0.3, 0.3), PUNE[1] + rng.uniform(-0.3, 0.3)
        rows.append(make_dealer(f"D{i}", round(lat, 6), round(lng, 6)))
    for radius_km in (1, 3, 5, 10, 20):
        got = {d.id: m for d, m in dealers_within(Dealer.objects.all(), *PUNE, radius_km * 1000)}
        want = {d.id for d in rows if haversine_m(*PUNE, float(d.latitude), float(d.longitude)) <= radius_km * 1000}
        assert set(got) == want
        assert all(m <= radius_km * 1000 for m in got.values())
        assert list(got.values()) == sorted(got.values())
    assert len(dealers_within(Dealer.objects.all(), *PUNE, 20_000)) > len(dealers_within(Dealer.objects.all(), *PUNE, 1_000))


def test_unlocated_and_null_island_dealers_are_never_returned():
    make_dealer("none")
    make_dealer("null island", 0, 0)
    good = make_dealer("near", PUNE[0] + KM, PUNE[1])
    assert [d.id for d, _ in dealers_within(Dealer.objects.all(), *PUNE, 5_000)] == [good.id]
    assert dealers_within(Dealer.objects.all(), 0.001, 0.001, 5_000) == []


def test_dealers_within_works_across_the_antimeridian():
    east = make_dealer("east", 0.0, 179.995)
    west = make_dealer("west", 0.0, -179.995)
    make_dealer("far", 0.0, 170.0)
    found = {d.id for d, _ in dealers_within(Dealer.objects.all(), 0.0, 180.0, 5_000)}
    assert found == {east.id, west.id}


def test_nearby_query_range_scans_the_lat_lng_index():
    """The bounding box must be answerable from dealer_lat_lng_idx, not a full table scan."""
    for i in range(200):
        make_dealer(f"D{i}", 10 + i * 0.05, 70 + i * 0.05)
    min_lat, max_lat, ranges = bounding_box(*PUNE, 5_000)
    qs = Dealer.objects.filter(latitude__isnull=False).filter(box_filter(min_lat, max_lat, ranges))
    sql, params = qs.query.sql_with_params()
    with connection.cursor() as cur:
        cur.execute("EXPLAIN QUERY PLAN " + sql, params)
        plan = " ".join(str(r[-1]) for r in cur.fetchall())
    assert "dealer_lat_lng_idx" in plan, plan
