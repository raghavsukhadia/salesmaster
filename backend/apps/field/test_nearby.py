from datetime import timedelta

import pytest
from django.utils import timezone

from apps.accounts.models import Role
from apps.dealers.models import DealerAccessGrant
from apps.field.helpers import KM, PUNE, api, go_on_duty, make_dealer, make_salesman, make_user, set_fix

pytestmark = pytest.mark.django_db
SAL = "/api/field/nearby-dealers/"
MGT = "/api/management/field/nearby-dealers/"


def at_km(km, north=True):
    return (PUNE[0] + (km * KM if north else -km * KM), PUNE[1])


@pytest.fixture
def world():
    """Dealers at 0.5, 2, 4, 8, 15 and 30 km north of a salesman who owns the first three."""
    sam = make_salesman("sam")
    other = make_salesman("other")
    d = {km: make_dealer(f"D{km}", *at_km(km), owner=(sam if km <= 4 else other)) for km in (0.5, 2, 4, 8, 15, 30)}
    return sam, other, d


def q(radius, **extra):
    return {"latitude": PUNE[0], "longitude": PUNE[1], "radius_km": radius, **extra}


# ---- salesman search ----------------------------------------------------------------------------------

@pytest.mark.parametrize("radius,expected", [(1, [0.5]), (3, [0.5, 2]), (5, [0.5, 2, 4])])
def test_salesman_sees_only_their_own_dealers_within_the_radius(world, radius, expected):
    sam, _, d = world
    r = api(sam.user).get(SAL, q(radius)).data
    assert [row["id"] for row in r["results"]] == [d[k].id for k in expected]
    assert r["radius_km"] == radius and r["distance_basis"] == "straight_line"


def test_each_row_separates_straight_line_from_driving_distance(world):
    sam, _, d = world
    row = api(sam.user).get(SAL, q(1)).data["results"][0]
    assert row["straight_line_m"] == pytest.approx(500, abs=5)
    assert row["driving_m"] is None  # never inferred from the straight line
    assert "straight-line" in api(sam.user).get(SAL, q(1)).data["distance_note"]


def test_salesman_response_leaks_no_owner_or_other_salesman_data(world):
    sam, _, _ = world
    row = api(sam.user).get(SAL, q(5)).data["results"][0]
    assert "owner" not in row and "status" not in row and "last_visit_at" not in row


def test_granted_dealers_are_included_and_ungranted_ones_are_not(world):
    sam, other, d = world
    assert d[8].id not in [r["id"] for r in api(sam.user).get(SAL, q(10)).data["results"]]
    DealerAccessGrant.objects.create(salesman=sam, dealer=d[8])
    assert d[8].id in [r["id"] for r in api(sam.user).get(SAL, q(10)).data["results"]]


@pytest.mark.parametrize("radius", [0, 2, 7, 25, 100, -5])
def test_only_the_configured_radii_are_allowed(world, radius):
    sam, _, _ = world
    assert api(sam.user).get(SAL, q(radius)).status_code == 400


@pytest.mark.parametrize("params", [
    {}, {"latitude": 18.5}, {"latitude": "x", "longitude": 1}, {"latitude": 95, "longitude": 1},
    {"latitude": "nan", "longitude": 1}, {"latitude": 0, "longitude": 0},
])
def test_bad_origin_is_a_400(world, params):
    sam, _, _ = world
    assert api(sam.user).get(SAL, params).status_code == 400


def test_archived_unlocated_and_null_island_dealers_are_excluded(world):
    sam, _, d = world
    d[0.5].is_archived = True
    d[0.5].save()
    make_dealer("unlocated", owner=sam)
    make_dealer("null island", 0, 0, owner=sam)
    ids = [r["id"] for r in api(sam.user).get(SAL, q(5)).data["results"]]
    assert ids == [d[2].id, d[4].id]


def test_verified_only_filter(world):
    sam, _, d = world
    d[2].location_verified_at = timezone.now()
    d[2].save()
    rows = api(sam.user).get(SAL, q(5, verified_only="true")).data["results"]
    assert [r["id"] for r in rows] == [d[2].id] and rows[0]["location_verified"] is True


def test_inactive_salesman_is_refused(world):
    sam, _, _ = world
    sam.is_active = False
    sam.save()
    assert api(sam.user).get(SAL, q(5)).status_code == 403


def test_results_are_capped_and_flagged_truncated(settings, world):
    sam, _, _ = world
    settings.FIELD_TRACKING = {**settings.FIELD_TRACKING, "NEARBY_LIMIT": 2}
    r = api(sam.user).get(SAL, q(5)).data
    assert len(r["results"]) == 2 and r["total"] == 3 and r["truncated"] is True


# ---- management search ----------------------------------------------------------------------------------

def test_management_sees_every_dealer_with_owner_and_status(world):
    sam, other, d = world
    mgr = make_user("boss", Role.MANAGER)
    r = api(mgr).get(MGT, q(10)).data
    assert [row["id"] for row in r["results"]] == [d[k].id for k in (0.5, 2, 4, 8)]
    by_id = {row["id"]: row for row in r["results"]}
    assert by_id[d[2].id]["owner"]["id"] == sam.id and by_id[d[8].id]["owner"]["id"] == other.id


def test_management_can_search_around_a_salesmans_live_position(world):
    sam, _, d = world
    s = set_fix(go_on_duty(sam), *at_km(8), age_s=20)
    r = api(make_user("boss", Role.MANAGER)).get(MGT, {"salesman_id": sam.id, "radius_km": 1}).data
    assert [row["id"] for row in r["results"]] == [d[8].id]
    assert r["origin"]["salesman_id"] == sam.id and r["origin"]["status"] == "live" and r["origin"]["captured_at"] is not None


def test_search_around_a_salesman_refuses_when_there_is_no_recent_location(world):
    sam, _, _ = world
    mgr = api(make_user("boss", Role.MANAGER))
    assert mgr.get(MGT, {"salesman_id": sam.id}).status_code == 400  # off duty
    s = go_on_duty(sam)
    assert mgr.get(MGT, {"salesman_id": sam.id}).status_code == 400  # on duty, no fix yet
    set_fix(s, *at_km(1), age_s=3 * 3600)
    assert mgr.get(MGT, {"salesman_id": sam.id}).status_code == 400  # fix is hours old: not a position to search from
    assert mgr.get(MGT, {"salesman_id": 999999}).status_code == 404


# ---- reverse search: nearest salesmen to a dealer ---------------------------------------------------------

def crew():
    dealer = make_dealer("Target", *PUNE)
    people = {n: make_salesman(n) for n in ("near", "mid", "far", "stale", "off", "idle")}
    set_fix(go_on_duty(people["near"]), *at_km(1), age_s=10)
    set_fix(go_on_duty(people["mid"]), *at_km(4), age_s=60)
    set_fix(go_on_duty(people["far"]), *at_km(12), age_s=100)
    set_fix(go_on_duty(people["stale"]), *at_km(0.2), age_s=600)  # closest, but 10 minutes old
    go_on_duty(people["idle"])  # on duty, no fix at all
    # "off" never goes on duty
    return dealer, people


def nearest(client, dealer, **params):
    return client.get(f"/api/management/field/dealers/{dealer.id}/nearest-salesmen/", params)


def test_reverse_search_ranks_live_on_duty_salesmen_by_distance():
    dealer, p = crew()
    r = nearest(api(make_user("boss", Role.MANAGER)), dealer).data
    assert [row["salesman_id"] for row in r["results"]] == [p["near"].id, p["mid"].id, p["far"].id]
    assert all(row["is_live"] and row["status"] == "live" and row["driving_m"] is None for row in r["results"])
    assert r["results"][0]["straight_line_m"] == pytest.approx(1000, abs=10)
    assert r["distance_basis"] == "straight_line"


def test_stale_positions_are_excluded_unless_asked_for_and_then_labelled():
    dealer, p = crew()
    c = api(make_user("boss", Role.MANAGER))
    ids = [row["salesman_id"] for row in nearest(c, dealer).data["results"]]
    assert p["stale"].id not in ids  # the closest salesman is 10 minutes old: not "available nearby"
    rows = nearest(c, dealer, include_stale="true").data["results"]
    assert rows[0]["salesman_id"] == p["stale"].id
    assert rows[0]["is_live"] is False and rows[0]["status"] == "stale" and rows[0]["age_s"] >= 590


def test_off_duty_and_inactive_salesmen_never_appear_and_limits_apply():
    dealer, p = crew()
    p["near"].is_active = False
    p["near"].save()
    c = api(make_user("boss", Role.MANAGER))
    r = nearest(c, dealer, include_stale="true").data["results"]
    assert {x["salesman_id"] for x in r} == {p["mid"].id, p["far"].id, p["stale"].id}
    assert [x["salesman_id"] for x in nearest(c, dealer, limit=1).data["results"]] == [p["mid"].id]
    assert [x["salesman_id"] for x in nearest(c, dealer, max_km=5).data["results"]] == [p["mid"].id]


def test_reverse_search_marks_the_dealers_own_salesman():
    dealer, p = crew()
    from apps.dealers.models import DealerOwnershipHistory
    DealerOwnershipHistory.objects.create(dealer=dealer, salesman=p["mid"])
    rows = {x["salesman_id"]: x for x in nearest(api(make_user("boss", Role.MANAGER)), dealer).data["results"]}
    assert rows[p["mid"].id]["is_owner"] and not rows[p["near"].id]["is_owner"]


def test_reverse_search_needs_a_dealer_with_a_location():
    c = api(make_user("boss", Role.MANAGER))
    assert nearest(c, make_dealer("No pin")).status_code == 400
    assert nearest(c, make_dealer("Null island", 0, 0)).status_code == 400
    r = c.get("/api/management/field/dealers/999999/nearest-salesmen/")
    assert r.status_code == 404
    dealer, _ = crew()
    assert nearest(c, dealer, max_km="abc").status_code == 400
    assert nearest(c, dealer, max_km=-1).status_code == 400
