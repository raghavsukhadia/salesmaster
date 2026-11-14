from datetime import timedelta

import pytest
from django.utils import timezone

from apps.accounts.models import Role
from apps.dealers.models import DealerAccessGrant
from apps.field.helpers import KM, PUNE, api, go_on_duty, make_dealer, make_salesman, make_user
from apps.field.models import BeatPlan, BeatStop, DealerCheckIn, FieldAuditLog

pytestmark = pytest.mark.django_db

BEATS = "/api/management/field/beats/"


def pos(ago=5):
    return {"latitude": PUNE[0], "longitude": PUNE[1], "accuracy_m": 10, "captured_at": (timezone.now() - timedelta(seconds=ago)).isoformat()}


@pytest.fixture
def team():
    sam = make_salesman("sam")
    dealers = [make_dealer(f"D{i}", PUNE[0] + i * 0.001, PUNE[1], owner=sam, city="Pune") for i in range(1, 5)]
    mgr = api(make_user("mgr", Role.MANAGER))
    return sam, dealers, mgr


def save(client, sam, dealers, date=None, note="", **kw):
    date = date or timezone.localdate()
    stops = [{"dealer_id": d.id} for d in dealers]
    return client.put(BEATS, {"salesman_id": sam.id, "date": str(date), "note": note, "stops": stops}, format="json", **kw)


def test_manager_plans_a_day_and_the_salesman_sees_it(team):
    sam, d, mgr = team
    r = save(mgr, sam, [d[2], d[0], d[1]], note="Pune west loop")
    assert r.status_code == 200, r.data
    plan = r.data["plan"]
    assert [s["dealer"]["name"] for s in plan["stops"]] == ["D3", "D1", "D2"] and [s["sequence"] for s in plan["stops"]] == [1, 2, 3]
    assert plan["note"] == "Pune west loop" and plan["counts"] == {"planned": 3, "in_progress": 0, "visited": 0, "skipped": 0}
    assert mgr.get(BEATS, {"salesman_id": sam.id}).data["plan"]["total"] == 3

    today = api(sam.user).get("/api/field/today/").data
    assert [s["dealer"]["name"] for s in today["plan"]["stops"]] == ["D3", "D1", "D2"]
    assert today["open_checkin"] is None and today["geofence"] == {"default_radius_m": 150, "mode": "enforce", "max_accuracy_m": 100}
    assert FieldAuditLog.objects.filter(action="beat_save", salesman=sam).count() == 1


def test_no_plan_is_not_an_error(team):
    sam, _, mgr = team
    assert mgr.get(BEATS, {"salesman_id": sam.id}).data["plan"] is None
    assert api(sam.user).get("/api/field/today/").data["plan"] is None


def test_reordering_keeps_the_stops_and_their_visits(team):
    sam, d, mgr = team
    save(mgr, sam, [d[0], d[1], d[2]])
    go_on_duty(sam)
    c = api(sam.user)
    cid = c.post("/api/field/checkins/", {"dealer_id": d[0].id, "position": pos()}, format="json").data["id"]
    ids_before = {s.dealer_id: s.id for s in BeatStop.objects.all()}
    r = save(mgr, sam, [d[2], d[1], d[0], d[3]])  # reversed, plus a new stop
    assert r.status_code == 200
    stops = {s["dealer"]["id"]: s for s in r.data["plan"]["stops"]}
    assert [s["dealer"]["name"] for s in r.data["plan"]["stops"]] == ["D3", "D2", "D1", "D4"]
    assert stops[d[0].id]["id"] == ids_before[d[0].id] and stops[d[0].id]["status"] == "in_progress"
    assert DealerCheckIn.objects.get(pk=cid).stop_id == ids_before[d[0].id]


def test_a_stop_with_a_visit_cannot_be_removed_or_the_plan_deleted(team):
    sam, d, mgr = team
    save(mgr, sam, [d[0], d[1]])
    go_on_duty(sam)
    api(sam.user).post("/api/field/checkins/", {"dealer_id": d[0].id, "position": pos()}, format="json")
    r = save(mgr, sam, [d[1]])
    assert r.status_code == 400 and r.data["code"] == "stop_has_visit"
    assert BeatStop.objects.count() == 2
    assert mgr.delete(BEATS + f"?salesman_id={sam.id}&date={timezone.localdate()}").status_code == 400
    assert BeatPlan.objects.count() == 1


def test_only_dealers_the_salesman_can_actually_visit_may_be_planned(team):
    sam, d, mgr = team
    other = make_salesman("other")
    theirs = make_dealer("Theirs", *PUNE, owner=other)
    archived = make_dealer("Archived", *PUNE, owner=sam, is_archived=True)
    for bad in (theirs, archived):
        r = save(mgr, sam, [d[0], bad])
        assert r.status_code == 400 and r.data["code"] == "dealer_not_available" and bad.name in r.data["detail"]
    assert BeatPlan.objects.count() == 0  # nothing half-saved
    DealerAccessGrant.objects.create(salesman=sam, dealer=theirs)
    assert save(mgr, sam, [d[0], theirs]).status_code == 200


def test_plan_validation(team):
    sam, d, mgr = team
    assert save(mgr, sam, [d[0], d[0]]).data["code"] == "duplicate_dealer"
    assert save(mgr, sam, [d[0]], date=timezone.localdate() - timedelta(days=1)).data["code"] == "past_date"
    assert save(mgr, sam, [d[0]], date=timezone.localdate() + timedelta(days=2)).status_code == 200  # future days are fine
    sam.is_active = False
    sam.save()
    assert save(mgr, sam, [d[0]]).status_code == 400
    assert mgr.put(BEATS, {"salesman_id": 999999, "date": "2030-01-01", "stops": []}, format="json").status_code == 404
    assert mgr.put(BEATS, {"salesman_id": sam.id, "date": "nope", "stops": []}, format="json").status_code == 400
    assert mgr.get(BEATS).status_code == 400  # salesman_id required


def test_stop_status_follows_the_visit(team):
    sam, d, mgr = team
    save(mgr, sam, [d[0], d[1], d[2]])
    go_on_duty(sam)
    c = api(sam.user)
    stop_id = {s.dealer_id: s.id for s in BeatStop.objects.all()}
    counts = lambda: c.get("/api/field/today/").data["plan"]["counts"]  # noqa: E731
    cid = c.post("/api/field/checkins/", {"dealer_id": d[0].id, "position": pos()}, format="json").data["id"]
    assert counts() == {"planned": 2, "in_progress": 1, "visited": 0, "skipped": 0}
    assert c.get("/api/field/today/").data["open_checkin"]["id"] == cid
    c.post(f"/api/field/checkins/{cid}/check-out/", {"position": pos(), "outcome": "interested"}, format="json")
    assert counts() == {"planned": 2, "in_progress": 0, "visited": 1, "skipped": 0}
    assert c.get("/api/field/today/").data["open_checkin"] is None

    # skipping needs a reason, works only on unvisited stops of today's plan
    assert c.post(f"/api/field/stops/{stop_id[d[1].id]}/skip/", {}, format="json").data["code"] == "reason_required"
    r = c.post(f"/api/field/stops/{stop_id[d[1].id]}/skip/", {"reason": "Shop closed"}, format="json")
    assert r.status_code == 200 and r.data["counts"] == {"planned": 1, "in_progress": 0, "visited": 1, "skipped": 1}
    assert c.post(f"/api/field/stops/{stop_id[d[0].id]}/skip/", {"reason": "x"}, format="json").status_code == 409  # already visited
    assert c.post("/api/field/stops/999999/skip/", {"reason": "x"}, format="json").status_code == 404


def test_a_salesman_cannot_touch_someone_elses_or_tomorrows_stop(team):
    sam, d, mgr = team
    other = make_salesman("other")
    mine = BeatStop.objects.create(plan=BeatPlan.objects.create(salesman=sam, date=timezone.localdate()), dealer=d[0], sequence=1)
    tomorrow = BeatStop.objects.create(plan=BeatPlan.objects.create(salesman=sam, date=timezone.localdate() + timedelta(days=1)), dealer=d[1], sequence=1)
    assert api(other.user).post(f"/api/field/stops/{mine.id}/skip/", {"reason": "x"}, format="json").status_code == 404
    assert api(sam.user).post(f"/api/field/stops/{tomorrow.id}/skip/", {"reason": "x"}, format="json").status_code == 404


def test_delete_an_unstarted_plan(team):
    sam, d, mgr = team
    save(mgr, sam, [d[0]])
    r = mgr.delete(BEATS + f"?salesman_id={sam.id}&date={timezone.localdate()}")
    assert r.status_code == 200 and r.data["deleted"] is True and BeatPlan.objects.count() == 0
    assert mgr.delete(BEATS + f"?salesman_id={sam.id}&date={timezone.localdate()}").data["deleted"] is False


def test_dealer_options_are_what_the_salesman_can_visit(team):
    sam, d, mgr = team
    other = make_salesman("other")
    theirs = make_dealer("Granted one", *PUNE, owner=other)
    ungranted = make_dealer("Not theirs", *PUNE, owner=other)
    DealerAccessGrant.objects.create(salesman=sam, dealer=theirs)
    r = mgr.get(BEATS + "dealer-options/", {"salesman_id": sam.id})
    names = {x["name"] for x in r.data}
    assert names == {"D1", "D2", "D3", "D4", "Granted one"} and ungranted.name not in names
    assert [x["name"] for x in mgr.get(BEATS + "dealer-options/", {"salesman_id": sam.id, "q": "grant"}).data] == ["Granted one"]
    assert r.data[0]["latitude"] is not None


# ---- management check-in log -----------------------------------------------------------------------------

def test_management_check_in_log(team):
    sam, d, mgr = team
    other = make_salesman("other")
    far = make_dealer("Far", PUNE[0] + 0.5 * KM, PUNE[1], owner=other)
    go_on_duty(sam)
    go_on_duty(other)
    c = api(sam.user)
    cid = c.post("/api/field/checkins/", {"dealer_id": d[0].id, "position": pos()}, format="json").data["id"]
    c.post(f"/api/field/checkins/{cid}/check-out/", {"position": pos(), "outcome": "call_again", "notes": "n"}, format="json")
    from apps.field.models import FieldConfig
    FieldConfig.objects.update_or_create(pk=1, defaults={"geofence_mode": "flag"})
    api(other.user).post("/api/field/checkins/", {"dealer_id": far.id, "position": {**pos(), "latitude": PUNE[0] + 0.9 * KM}, "reason": "GPS drift"}, format="json")

    r = mgr.get("/api/management/field/checkins/").data
    assert r["summary"] == {"total": 2, "open": 1, "flagged": 1, "verified_inside": 1} and r["count"] == 2
    rows = {x["dealer"]["name"]: x for x in r["results"]}
    assert rows["D1"]["outcome"] == "call_again" and rows["D1"]["visit_id"] and rows["D1"]["flagged"] is False and rows["D1"]["checked_out_at"]
    assert rows["Far"]["flagged"] is True and rows["Far"]["in_geofence"] == "outside" and rows["Far"]["in_override_reason"] == "GPS drift"
    assert [x["dealer"]["name"] for x in mgr.get("/api/management/field/checkins/", {"flagged": "1"}).data["results"]] == ["Far"]
    assert [x["salesman"] for x in mgr.get("/api/management/field/checkins/", {"salesman_id": sam.id}).data["results"]] == ["sam"]
    assert mgr.get("/api/management/field/checkins/", {"date": "2020-01-01"}).data["summary"]["total"] == 0
    assert mgr.get("/api/management/field/checkins/", {"date": "bad"}).status_code == 400
