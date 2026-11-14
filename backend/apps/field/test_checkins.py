import uuid
from datetime import timedelta

import pytest
from django.utils import timezone

from apps.accounts.models import Role
from apps.dealers.models import DealerAccessGrant
from apps.field.helpers import KM, PUNE, api, go_on_duty, make_dealer, make_salesman, make_user
from apps.field.models import BeatPlan, BeatStop, DealerCheckIn, FieldAuditLog, FieldConfig, LocationPing, WorkSession
from apps.visits.models import Followup, Product, Visit, VisitOrderItem

pytestmark = pytest.mark.django_db

IN, OUT = "/api/field/checkins/", lambda pk: f"/api/field/checkins/{pk}/check-out/"


def pos(km_north=0.0, acc=10.0, ago=5, at=None):
    """A reading ``km_north`` kilometres north of the dealer at PUNE."""
    when = at or timezone.now() - timedelta(seconds=ago)
    return {"latitude": round(PUNE[0] + km_north * KM, 6), "longitude": PUNE[1], "accuracy_m": acc, "captured_at": when.isoformat()}


@pytest.fixture
def world():
    sam = make_salesman("sam")
    dealer = make_dealer("Sharma Auto", *PUNE, owner=sam, city="Pune")
    go_on_duty(sam)
    return sam, dealer, api(sam.user)


def body(dealer, **kw):
    return {"dealer_id": dealer.id, "position": pos(), **kw}


def set_cfg(**kw):
    FieldConfig.objects.update_or_create(pk=1, defaults=kw)


# ---- check-in ----------------------------------------------------------------------------------------

def test_check_in_inside_the_geofence(world):
    sam, dealer, c = world
    r = c.post(IN, body(dealer, position=pos(0.08)), format="json")  # ~80 m, default radius 150 m
    assert r.status_code == 201, r.data
    assert r.data["in_geofence"] == "inside" and 70 <= r.data["in_distance_m"] <= 90 and r.data["radius_m"] == 150
    assert r.data["flagged"] is False and r.data["dealer"]["name"] == "Sharma Auto"
    ci = DealerCheckIn.objects.get()
    assert ci.salesman == sam and ci.checked_out_at is None and ci.in_dealer_verified is False
    # the verified reading also feeds live tracking
    assert LocationPing.objects.count() == 1 and WorkSession.objects.get().last_fix_at is not None


def test_check_in_needs_a_duty_session():
    sam = make_salesman("sam")
    dealer = make_dealer("D", *PUNE, owner=sam)
    r = api(sam.user).post(IN, body(dealer), format="json")
    assert r.status_code == 409 and r.data["code"] == "not_on_duty"
    assert DealerCheckIn.objects.count() == 0


def test_enforce_mode_blocks_check_in_outside_the_geofence_and_says_why(world):
    _, dealer, c = world
    r = c.post(IN, body(dealer, position=pos(0.4)), format="json")  # ~400 m away
    assert r.status_code == 422 and r.data["code"] == "geofence_outside"
    assert 380 <= r.data["distance_m"] <= 420 and r.data["radius_m"] == 150 and r.data["can_override"] is False
    assert str(r.data["distance_m"]) in r.data["detail"] and "Sharma Auto" in r.data["detail"]
    assert DealerCheckIn.objects.count() == 0


def test_flag_mode_allows_it_but_demands_a_reason_and_records_the_override(world):
    sam, dealer, c = world
    set_cfg(geofence_mode="flag")
    r = c.post(IN, body(dealer, position=pos(0.4)), format="json")
    assert r.status_code == 400 and r.data["code"] == "reason_required" and r.data["can_override"] is True
    r = c.post(IN, body(dealer, position=pos(0.4), reason="Shop is round the corner, GPS drifted"), format="json")
    assert r.status_code == 201 and r.data["in_geofence"] == "outside" and r.data["flagged"] is True
    assert r.data["in_override_reason"].startswith("Shop is round")
    a = FieldAuditLog.objects.get(action="checkin_override")
    assert a.salesman == sam and a.dealer_id == dealer.id and a.detail["phase"] == "in"


def test_geofence_radius_comes_from_the_dealer_or_the_default(world):
    _, dealer, c = world
    assert c.post(IN, body(dealer, position=pos(0.3)), format="json").status_code == 422   # 300 m > 150 m
    dealer.geofence_radius_m = 400
    dealer.save()
    r = c.post(IN, body(dealer, position=pos(0.3)), format="json")                          # per-dealer override
    assert r.status_code == 201 and r.data["radius_m"] == 400
    DealerCheckIn.objects.all().delete()
    dealer.geofence_radius_m = None
    dealer.save()
    set_cfg(default_geofence_m=500)
    assert c.post(IN, body(dealer, position=pos(0.3)), format="json").status_code == 201    # configurable default


def test_a_reading_too_imprecise_to_verify_is_not_treated_as_inside(world):
    _, dealer, c = world
    r = c.post(IN, body(dealer, position=pos(0.05, acc=300)), format="json")  # 50 m away, but +-300 m
    assert r.status_code == 422 and r.data["code"] == "geofence_low_accuracy" and r.data["accuracy_m"] == 300
    # far beyond the whole error circle: simply outside, not "can't tell"
    r = c.post(IN, body(dealer, position=pos(5, acc=300)), format="json")
    assert r.status_code == 422 and r.data["code"] == "geofence_outside"
    # accuracy exactly at the limit still verifies
    assert c.post(IN, body(dealer, position=pos(0.05, acc=100)), format="json").status_code == 201


def test_dealer_without_a_location_can_still_be_visited_but_is_flagged(world):
    sam, _, c = world
    bare = make_dealer("No pin", owner=sam)
    r = c.post(IN, {"dealer_id": bare.id, "position": pos()}, format="json")
    assert r.status_code == 201 and r.data["in_geofence"] == "no_dealer_location" and r.data["in_distance_m"] is None
    assert r.data["flagged"] is True


def test_the_dealers_own_location_verification_is_recorded(world):
    _, dealer, c = world
    dealer.location_verified_at = timezone.now()
    dealer.save()
    assert c.post(IN, body(dealer), format="json").status_code == 201
    assert DealerCheckIn.objects.get().in_dealer_verified is True


@pytest.mark.parametrize("position,code", [
    (lambda: pos(ago=600), "stale_position"),
    (lambda: pos(ago=-600), "stale_position"),
    (lambda: pos(acc=5000), "position_unusable"),
    (lambda: {**pos(), "latitude": 0.0, "longitude": 0.0}, "position_unusable"),
])
def test_unusable_readings_are_refused(world, position, code):
    _, dealer, c = world
    r = c.post(IN, {"dealer_id": dealer.id, "position": position()}, format="json")
    assert r.status_code == 422 and r.data["code"] == code
    assert DealerCheckIn.objects.count() == 0


def test_a_slow_device_clock_is_corrected_like_tracked_points(world):
    """The phone thinks it is 10 minutes earlier; its reading (taken 'just now' by its own clock) must be accepted."""
    _, dealer, c = world
    device_now = timezone.now() - timedelta(minutes=10)
    r = c.post(IN, {"dealer_id": dealer.id, "position": pos(at=device_now - timedelta(seconds=5)), "sent_at": device_now.isoformat()}, format="json")
    assert r.status_code == 201, r.data
    assert DealerCheckIn.objects.get().checked_in_at > timezone.now() - timedelta(seconds=30)  # server time, never the device's


@pytest.mark.parametrize("bad", [
    {"position": {"latitude": "NaN", "longitude": 1, "accuracy_m": 5, "captured_at": "2026-01-01T00:00:00Z"}},
    {"position": {"latitude": 91, "longitude": 1, "accuracy_m": 5, "captured_at": "2026-01-01T00:00:00Z"}},
    {"position": {}},
    {},
])
def test_malformed_check_in_bodies_are_400(world, bad):
    _, dealer, c = world
    assert c.post(IN, {"dealer_id": dealer.id, **bad}, format="json").status_code == 400


def test_only_accessible_dealers_can_be_checked_in_to(world):
    sam, _, c = world
    other = make_salesman("other")
    theirs = make_dealer("Theirs", *PUNE, owner=other)
    assert c.post(IN, {"dealer_id": theirs.id, "position": pos()}, format="json").status_code == 404
    DealerAccessGrant.objects.create(salesman=sam, dealer=theirs)
    assert c.post(IN, {"dealer_id": theirs.id, "position": pos()}, format="json").status_code == 201
    archived = make_dealer("Old", *PUNE, owner=sam, is_archived=True)
    DealerCheckIn.objects.all().delete()
    assert c.post(IN, {"dealer_id": archived.id, "position": pos()}, format="json").status_code == 404
    assert c.post(IN, {"dealer_id": 999999, "position": pos()}, format="json").status_code == 404


def test_one_open_check_in_per_salesman_and_idempotent_retries(world):
    sam, dealer, c = world
    other_dealer = make_dealer("Second", *PUNE, owner=sam)
    rid = str(uuid.uuid4())
    first = c.post(IN, body(dealer, client_request_id=rid), format="json")
    again = c.post(IN, body(dealer, client_request_id=rid), format="json")
    assert first.status_code == 201 and again.status_code == 200 and first.data["id"] == again.data["id"]
    r = c.post(IN, {"dealer_id": other_dealer.id, "position": pos()}, format="json")
    assert r.status_code == 409 and r.data["code"] == "already_checked_in" and r.data["checkin_id"] == first.data["id"]
    assert DealerCheckIn.objects.count() == 1


def test_two_salesmen_can_be_at_the_same_dealer():
    a, b = make_salesman("a"), make_salesman("b")
    dealer = make_dealer("Shared", *PUNE, owner=a)
    DealerAccessGrant.objects.create(salesman=b, dealer=dealer)
    go_on_duty(a)
    go_on_duty(b)
    assert api(a.user).post(IN, {"dealer_id": dealer.id, "position": pos()}, format="json").status_code == 201
    assert api(b.user).post(IN, {"dealer_id": dealer.id, "position": pos()}, format="json").status_code == 201


# ---- check-out ---------------------------------------------------------------------------------------

def out_body(**kw):
    return {"position": pos(0.02), "outcome": "interested", "notes": "Wants film samples", **kw}


def checked_in(world):
    _, dealer, c = world
    return c.post(IN, body(dealer), format="json").data["id"]


def test_check_out_creates_the_visit_order_and_followup_through_the_existing_flow(world):
    sam, dealer, c = world
    cat = Product.objects.create(name="Film A")
    cid = checked_in(world)
    due = (timezone.localdate() + timedelta(days=3)).isoformat()
    r = c.post(OUT(cid), out_body(
        outcome="order_taken", has_order=True, order_items=[{"product_id": cat.id, "quantity": 4}, {"product_name": "Custom tint", "quantity": 2}],
        followup={"due_date": due, "priority": "high", "notes": "Confirm delivery"}, client_request_id=str(uuid.uuid4()),
    ), format="json")
    assert r.status_code == 200, r.data
    ci = DealerCheckIn.objects.get()
    assert ci.checked_out_at is not None and ci.outcome == "order_taken" and ci.out_geofence == "inside" and ci.visit_id == r.data["visit_id"]
    v = Visit.objects.get()
    assert v.salesman == sam and v.dealer == dealer and v.visited_at == ci.checked_in_at and v.location_source == "gps_checkin"
    assert sorted(i.product_name for i in VisitOrderItem.objects.filter(visit=v)) == ["Custom tint", "Film A"]
    fu = Followup.objects.get(visit=v)
    assert str(fu.due_date) == due and fu.priority == "high"
    dealer.refresh_from_db()
    assert dealer.last_visit_at == v.visited_at and str(dealer.next_followup_at) == due


def test_check_out_is_idempotent_and_a_second_check_out_is_refused(world):
    _, _, c = world
    cid = checked_in(world)
    rid = str(uuid.uuid4())
    assert c.post(OUT(cid), out_body(client_request_id=rid), format="json").status_code == 200
    assert c.post(OUT(cid), out_body(client_request_id=rid), format="json").status_code == 200
    assert Visit.objects.count() == 1
    r = c.post(OUT(cid), out_body(client_request_id=str(uuid.uuid4())), format="json")
    assert r.status_code == 409 and r.data["code"] == "already_checked_out"
    assert Visit.objects.count() == 1


def test_outcome_and_order_items_must_agree(world):
    _, _, c = world
    cid = checked_in(world)
    assert c.post(OUT(cid), out_body(outcome="order_taken"), format="json").status_code == 400
    assert c.post(OUT(cid), out_body(has_order=True, order_items=[{"product_name": "x", "quantity": 1}]), format="json").status_code == 400
    assert c.post(OUT(cid), out_body(outcome="bogus"), format="json").status_code == 400
    assert c.post(OUT(cid), out_body(followup={"due_date": "2020-01-01"}), format="json").status_code == 400
    assert DealerCheckIn.objects.get().checked_out_at is None and Visit.objects.count() == 0


def test_a_failed_check_out_changes_nothing(world):
    """An unavailable product is rejected by the existing visit service: the check-in must stay open."""
    _, _, c = world
    gone = Product.objects.create(name="Discontinued", is_active=False)
    cid = checked_in(world)
    r = c.post(OUT(cid), out_body(outcome="order_taken", has_order=True, order_items=[{"product_id": gone.id, "quantity": 1}]), format="json")
    assert r.status_code == 400
    assert DealerCheckIn.objects.get().checked_out_at is None and Visit.objects.count() == 0


def test_check_out_away_from_the_dealer_needs_a_reason_even_in_enforce_mode(world):
    """Blocking would trap a salesman who has already left; instead the override is explained, flagged and audited."""
    sam, _, c = world
    cid = checked_in(world)
    r = c.post(OUT(cid), out_body(position=pos(0.6)), format="json")
    assert r.status_code == 400 and r.data["code"] == "reason_required" and r.data["can_override"] is True
    assert DealerCheckIn.objects.get().checked_out_at is None
    r = c.post(OUT(cid), out_body(position=pos(0.6), reason="Left for the next shop, forgot to check out"), format="json")
    assert r.status_code == 200 and r.data["out_geofence"] == "outside" and r.data["flagged"] is True
    assert FieldAuditLog.objects.filter(action="checkin_override", salesman=sam, detail__phase="out").count() == 1


def test_other_salesmens_check_ins_are_invisible(world):
    _, _, c = world
    other = make_salesman("other")
    go_on_duty(other)
    theirs = make_dealer("T", *PUNE, owner=other)
    cid = api(other.user).post(IN, {"dealer_id": theirs.id, "position": pos()}, format="json").data["id"]
    assert c.post(OUT(cid), out_body(), format="json").status_code == 404
    assert c.post(OUT(999999), out_body(), format="json").status_code == 404


def test_check_in_links_to_todays_beat_stop_only(world):
    sam, dealer, c = world
    today = timezone.localdate()
    plan = BeatPlan.objects.create(salesman=sam, date=today)
    stop = BeatStop.objects.create(plan=plan, dealer=dealer, sequence=1)
    cid = checked_in(world)
    assert DealerCheckIn.objects.get(pk=cid).stop == stop
    c.post(OUT(cid), out_body(), format="json")
    other_day = BeatPlan.objects.create(salesman=sam, date=today + timedelta(days=1))
    BeatStop.objects.create(plan=other_day, dealer=dealer, sequence=1)
    cid2 = c.post(IN, body(dealer), format="json").data["id"]
    assert DealerCheckIn.objects.get(pk=cid2).stop == stop  # today's plan, not tomorrow's
