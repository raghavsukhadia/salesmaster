"""Salesman portal: profile, login hardening, order pricing, follow-up times, standalone follow-ups and the badge counts."""
from datetime import datetime, timedelta

import pytest
from django.utils import timezone
from rest_framework.test import APIClient

from apps.accounts.models import Role, Salesman, User
from apps.dealers.models import Dealer, DealerOwnershipHistory
from apps.visits.models import Followup, Visit, VisitOrderItem

pytestmark = pytest.mark.django_db

PW = "Sup3r-secret-pw"


def mk(name, role=Role.SALESMAN, phone=None, **extra):
    u = User.objects.create_user(name, password=PW, role=role, **extra)
    return u, (Salesman.objects.create(user=u, phone_number=phone) if phone else None)


def api(user=None):
    c = APIClient()
    if user:
        c.force_authenticate(user)
    return c


def hhmm(dt):
    return dt.strftime("%H:%M")


@pytest.fixture
def w():
    alice, a = mk("alice", phone="9000000001", first_name="Alice", last_name="Rao")
    bob, b = mk("bob", phone="9000000002")
    admin, _ = mk("boss", Role.ADMIN)
    mgr, _ = mk("mgr", Role.MANAGER)
    mine = Dealer.objects.create(name="Sharma Auto", phone="9111111111", city="Pune")
    theirs = Dealer.objects.create(name="Hidden Garage", city="Goa")
    DealerOwnershipHistory.objects.create(dealer=mine, salesman=a)
    DealerOwnershipHistory.objects.create(dealer=theirs, salesman=b)
    return dict(alice=alice, a=a, bob=bob, b=b, admin=admin, mgr=mgr, mine=mine, theirs=theirs, today=timezone.localdate())


# ───────────────────────── profile ─────────────────────────

def test_me_returns_name_and_designation(w):
    r = api(w["alice"]).get("/api/me/")
    assert r.status_code == 200
    assert r.data == {"id": w["alice"].id, "username": "alice", "role": "salesman", "name": "Alice Rao", "designation": "Salesman"}
    # No name on file: fall back to the username rather than showing a blank header.
    assert api(w["bob"]).get("/api/me/").data["name"] == "bob"
    assert api(w["admin"]).get("/api/me/").data["designation"] == "Admin"
    assert api(w["mgr"]).get("/api/me/").data["designation"] == "Manager"


def test_me_requires_login():
    assert api().get("/api/me/").status_code == 401


def test_dealer_search_returns_phone_and_only_own_dealers(w):
    r = api(w["alice"]).get("/api/salesman/dealers/?q=sharma")
    assert [d["name"] for d in r.data] == ["Sharma Auto"] and r.data[0]["phone"] == "9111111111"
    assert api(w["alice"]).get("/api/salesman/dealers/?q=hidden").data == []


# ───────────────────────── login hardening ─────────────────────────

def test_login_works_and_wrong_password_is_a_plain_401(w):
    assert api().post("/api/auth/token/", {"username": "alice", "password": PW}, format="json").status_code == 200
    bad = api().post("/api/auth/token/", {"username": "alice", "password": "nope"}, format="json")
    assert bad.status_code == 401
    # Same answer for an unknown user: the response must not reveal which usernames exist.
    unknown = api().post("/api/auth/token/", {"username": "ghost", "password": "nope"}, format="json")
    assert unknown.status_code == 401 and unknown.data == bad.data


def test_repeated_guesses_at_one_account_are_throttled(w):
    c = api()
    codes = [c.post("/api/auth/token/", {"username": "alice", "password": f"guess-{i}"}, format="json").status_code for i in range(12)]
    assert codes[:10] == [401] * 10
    assert codes[10:] == [429, 429]
    # Even the right password is refused while blocked, and another account is unaffected.
    assert c.post("/api/auth/token/", {"username": "alice", "password": PW}, format="json").status_code == 429
    assert c.post("/api/auth/token/", {"username": "bob", "password": PW}, format="json").status_code == 200


def test_username_throttle_ignores_case_and_a_forged_forwarded_header(w):
    c = api()
    for i in range(10):
        c.post("/api/auth/token/", {"username": "ALICE " if i % 2 else "alice", "password": "x"}, format="json", HTTP_X_FORWARDED_FOR=f"10.0.0.{i}")
    r = c.post("/api/auth/token/", {"username": "Alice", "password": PW}, format="json", HTTP_X_FORWARDED_FOR="10.9.9.9")
    assert r.status_code == 429


def login_as(ident, password=PW):
    return api().post("/api/auth/token/", {"username": ident, "password": password}, format="json")


def test_a_salesman_can_sign_in_with_their_email_address():
    mk("emma", phone="9000000011", email="Emma.Rao@Example.com")
    for ident in ("emma.rao@example.com", "EMMA.RAO@EXAMPLE.COM", "  Emma.Rao@Example.com "):
        assert login_as(ident).status_code == 200, ident
    assert login_as("emma", PW).status_code == 200  # the username still works
    assert login_as("emma.rao@example.com", "wrong").status_code == 401
    assert login_as("nobody@example.com").status_code == 401


def test_an_email_shared_by_two_accounts_signs_neither_in():
    mk("twin1", phone="9000000012", email="shared@example.com")
    mk("twin2", phone="9000000013", email="shared@example.com")
    assert login_as("shared@example.com").status_code == 401  # ambiguous: refuse rather than guess
    assert login_as("twin1").status_code == 200


def test_a_username_that_looks_like_an_email_is_never_hijacked_by_someone_elses_email():
    mk("victim@corp.in", phone="9000000014", email="v@example.com")
    mk("thief", phone="9000000015", email="victim@corp.in")
    # "victim@corp.in" is a real username, so it is the username lookup that decides: the thief's password does not open it.
    u = User.objects.get(username="victim@corp.in")
    u.set_password("Another-pw-4455")
    u.save()
    assert login_as("victim@corp.in", PW).status_code == 401
    assert login_as("victim@corp.in", "Another-pw-4455").status_code == 200


def test_an_inactive_account_cannot_sign_in_by_email():
    u, _ = mk("gone", phone="9000000016", email="gone@example.com")
    u.is_active = False
    u.save()
    assert login_as("gone@example.com").status_code == 401


def test_login_without_a_username_is_rejected_not_a_server_error():
    assert api().post("/api/auth/token/", {"password": "x"}, format="json").status_code == 400


def test_admin_password_reset_signs_the_old_session_out(w):
    login = api().post("/api/auth/token/", {"username": "alice", "password": PW}, format="json").data
    access = APIClient()
    access.credentials(HTTP_AUTHORIZATION=f"Bearer {login['access']}")
    assert access.get("/api/me/").status_code == 200

    r = api(w["admin"]).post(f"/api/management/salesmen/{w['a'].id}/reset-password/", {"password": "Br4nd-new-pw-77"}, format="json")
    assert r.status_code == 200

    assert access.get("/api/me/").status_code == 401  # the old access token is dead
    refreshed = api().post("/api/auth/token/refresh/", {"refresh": login["refresh"]}, format="json")
    if refreshed.status_code == 200:  # a stolen refresh token may still mint a token, but that token must not work
        stale = APIClient()
        stale.credentials(HTTP_AUTHORIZATION=f"Bearer {refreshed.data['access']}")
        assert stale.get("/api/me/").status_code == 401
    fresh = api().post("/api/auth/token/", {"username": "alice", "password": "Br4nd-new-pw-77"}, format="json")
    assert fresh.status_code == 200


# ───────────────────────── order prices ─────────────────────────

def record(user, **body):
    return api(user).post("/api/visits/record/", body, format="json")


def test_order_lines_keep_unit_and_price_and_the_total_is_computed(w):
    r = record(w["alice"], dealer_id=w["mine"].id, has_order=True, order_items=[
        {"product_name": "Ceramic Film", "quantity": 3, "unit": "roll", "unit_price": "1250.50"},
        {"product_name": "Cleaner", "quantity": 10, "unit": "ltr", "unit_price": "99"},
        {"product_name": "Sample", "quantity": 1},  # unpriced: still recorded
    ])
    assert r.status_code == 201, r.data
    lines = {i.product_name: i for i in VisitOrderItem.objects.filter(visit_id=r.data["visit_id"])}
    assert (lines["Ceramic Film"].unit, str(lines["Ceramic Film"].unit_price)) == ("roll", "1250.50")
    assert (lines["Sample"].unit, lines["Sample"].unit_price) == ("pcs", 0)

    d = api(w["alice"]).get(f"/api/salesman/visits/{r.data['visit_id']}/").data
    assert d["order_total"] == pytest.approx(3 * 1250.50 + 10 * 99)
    by = {i["name"]: i for i in d["order_items"]}
    assert by["Ceramic Film"]["line_total"] == pytest.approx(3751.5) and by["Sample"]["line_total"] == 0
    assert d["status"] == "order"


@pytest.mark.parametrize("item", [
    {"product_name": "X", "quantity": 1, "unit_price": "-1"},
    {"product_name": "X", "quantity": 1, "unit_price": "abc"},
    {"product_name": "X", "quantity": 1, "unit_price": "1234567890123"},
    {"product_name": "X", "quantity": 1, "unit": "bags"},
])
def test_bad_prices_and_units_are_rejected_and_nothing_is_saved(w, item):
    r = record(w["alice"], dealer_id=w["mine"].id, has_order=True, order_items=[item])
    assert r.status_code == 400
    assert Visit.objects.count() == 0


def test_visit_list_shows_status_total_and_a_preview(w):
    a, mine = w["a"], w["mine"]
    now = timezone.now()
    ordered = Visit.objects.create(salesman=a, dealer=mine, visited_at=now)
    for n, q in (("A", 1), ("B", 2), ("C", 3), ("D", 4)):
        VisitOrderItem.objects.create(visit=ordered, product_name=n, quantity=q, unit_price=10)
    follow = Visit.objects.create(salesman=a, dealer=mine, visited_at=now - timedelta(hours=1))
    Followup.objects.create(dealer=mine, salesman=a, visit=follow, due_date=w["today"])
    plain = Visit.objects.create(salesman=a, dealer=mine, visited_at=now - timedelta(hours=2))
    rows = {x["id"]: x for x in api(w["alice"]).get("/api/salesman/visits/").data["results"]}
    assert rows[ordered.id]["status"] == "order" and rows[ordered.id]["order_total"] == 100
    assert [p["name"] for p in rows[ordered.id]["order_preview"]] == ["A", "B", "C"]  # first three only
    assert rows[follow.id]["status"] == "followup" and rows[follow.id]["order_total"] == 0
    assert rows[plain.id]["status"] == "visited"


def test_visit_list_filters_by_status_and_shows_the_followup_time(w):
    a, mine, now = w["a"], w["mine"], timezone.now()
    ordered = Visit.objects.create(salesman=a, dealer=mine, visited_at=now)
    VisitOrderItem.objects.create(visit=ordered, product_name="A", quantity=1)
    # An order AND a pending follow-up is still just "order": the order wins.
    Followup.objects.create(dealer=mine, salesman=a, visit=ordered, due_date=w["today"])
    follow = Visit.objects.create(salesman=a, dealer=mine, visited_at=now - timedelta(hours=1))
    Followup.objects.create(dealer=mine, salesman=a, visit=follow, due_date=w["today"] + timedelta(days=2), due_time="11:30")
    done = Visit.objects.create(salesman=a, dealer=mine, visited_at=now - timedelta(hours=2))
    Followup.objects.create(dealer=mine, salesman=a, visit=done, due_date=w["today"], status="completed")
    plain = Visit.objects.create(salesman=a, dealer=mine, visited_at=now - timedelta(hours=3))
    c = api(w["alice"])

    def ids(status):
        return {x["id"] for x in c.get(f"/api/salesman/visits/?status={status}").data["results"]}

    assert ids("order") == {ordered.id}
    assert ids("followup") == {follow.id}
    assert ids("visited") == {done.id, plain.id}  # a completed follow-up no longer makes it "pending"
    assert len(c.get("/api/salesman/visits/?status=bogus").data["results"]) == 4  # unknown value: no filtering
    rows = {x["id"]: x for x in c.get("/api/salesman/visits/").data["results"]}
    assert rows[follow.id]["followup_due_time"] == "11:30" and rows[plain.id]["followup_due_time"] is None
    # Another salesman's visits never appear, whatever the filter.
    other = Visit.objects.create(salesman=w["b"], dealer=w["theirs"], visited_at=now)
    assert other.id not in ids("visited")


# ───────────────────────── follow-up time on a visit ─────────────────────────

def future_slot():
    """Tomorrow at 10:30: never in the past, whatever time the suite runs."""
    return (timezone.localdate() + timedelta(days=1)).isoformat(), "10:30"


def test_visit_followup_keeps_its_time_and_it_shows_in_the_lists(w):
    day, t = future_slot()
    r = record(w["alice"], dealer_id=w["mine"].id, followup={"due_date": day, "due_time": t, "priority": "high"})
    assert r.status_code == 201, r.data
    f = Followup.objects.get(visit_id=r.data["visit_id"])
    assert f.due_time.strftime("%H:%M") == t
    row = api(w["alice"]).get("/api/salesman/followups/").data["results"][0]
    assert (str(row["due_date"]), row["due_time"]) == (day, t)
    detail = api(w["alice"]).get(f"/api/salesman/visits/{r.data['visit_id']}/").data
    assert detail["followups"][0]["due_time"] == t
    # Managers see the same time on their screens.
    m = api(w["mgr"]).get(f"/api/management/followups/{f.id}/").data
    assert m["due_time"] == t


def test_a_time_that_already_passed_today_is_refused(w):
    past = timezone.localtime() - timedelta(hours=2)
    if past.date() != w["today"]:
        pytest.skip("less than two hours into the day: cannot build a past time for today")
    r = record(w["alice"], dealer_id=w["mine"].id, followup={"due_date": w["today"].isoformat(), "due_time": hhmm(past)})
    assert r.status_code == 400 and "due_time" in r.data["followup"]
    assert Visit.objects.count() == 0  # the visit was not saved either


def test_followup_without_a_time_still_works(w):
    r = record(w["alice"], dealer_id=w["mine"].id, followup={"due_date": future_slot()[0]})
    assert r.status_code == 201
    assert Followup.objects.get().due_time is None
    assert api(w["alice"]).get("/api/salesman/followups/").data["results"][0]["due_time"] is None


# ───────────────────────── standalone follow-ups ─────────────────────────

URL = "/api/salesman/followups/"


def create(user, **body):
    return api(user).post(URL, body, format="json")


def test_salesman_creates_a_followup_for_their_dealer(w):
    day, t = future_slot()
    r = create(w["alice"], dealer_id=w["mine"].id, due_date=day, due_time=t, priority="high", notes="Send quotation")
    assert r.status_code == 201, r.data
    assert (str(r.data["due_date"]), r.data["due_time"], r.data["priority"], r.data["state"]) == (day, t, "high", "upcoming")
    assert r.data["dealer"]["name"] == "Sharma Auto"
    f = Followup.objects.get(pk=r.data["id"])
    assert f.salesman == w["a"] and f.visit is None and f.status == "pending" and f.notes == "Send quotation"
    w["mine"].refresh_from_db()
    assert str(w["mine"].next_followup_at) == day


def test_dealer_reminder_date_tracks_the_earliest_pending_followup(w):
    later = (w["today"] + timedelta(days=20)).isoformat()
    sooner = (w["today"] + timedelta(days=3)).isoformat()
    create(w["alice"], dealer_id=w["mine"].id, due_date=sooner)
    create(w["alice"], dealer_id=w["mine"].id, due_date=later)
    w["mine"].refresh_from_db()
    assert str(w["mine"].next_followup_at) == sooner


def test_cannot_create_a_followup_for_someone_elses_dealer(w):
    day, _ = future_slot()
    r = create(w["alice"], dealer_id=w["theirs"].id, due_date=day)
    assert r.status_code == 404
    assert create(w["alice"], dealer_id=999999, due_date=day).status_code == 404  # indistinguishable from a real one
    assert Followup.objects.count() == 0


@pytest.mark.parametrize("who", ["admin", "mgr"])
def test_management_cannot_use_the_salesman_followup_endpoints(w, who):
    day, _ = future_slot()
    assert create(w[who], dealer_id=w["mine"].id, due_date=day).status_code == 403
    assert api(w[who]).get(URL + "summary/").status_code == 403


def test_followup_endpoints_need_login(w):
    assert api().post(URL, {"dealer_id": w["mine"].id, "due_date": future_slot()[0]}, format="json").status_code == 401
    assert api().get(URL + "summary/").status_code == 401


@pytest.mark.parametrize("bad", [
    {"due_date": "2000-01-01"},
    {"due_date": "not-a-date"},
    {"due_time": "25:61", "due_date": "TOMORROW"},
    {},
])
def test_invalid_followup_input_is_rejected(w, bad):
    r = create(w["alice"], dealer_id=w["mine"].id, **bad)
    assert r.status_code == 400 and Followup.objects.count() == 0


def test_followup_more_than_a_year_ahead_is_rejected(w):
    far = (w["today"] + timedelta(days=400)).isoformat()
    r = create(w["alice"], dealer_id=w["mine"].id, due_date=far)
    assert r.status_code == 400 and "due_date" in r.data


def test_followup_time_already_passed_today_is_rejected(w):
    past = timezone.localtime() - timedelta(hours=2)
    if past.date() != w["today"]:
        pytest.skip("less than two hours into the day")
    r = create(w["alice"], dealer_id=w["mine"].id, due_date=w["today"].isoformat(), due_time=hhmm(past))
    assert r.status_code == 400 and "due_time" in r.data


def test_a_few_minutes_of_slack_for_a_slow_form(w):
    just_now = timezone.localtime() - timedelta(minutes=2)
    if just_now.date() != w["today"]:
        pytest.skip("too close to midnight")
    r = create(w["alice"], dealer_id=w["mine"].id, due_date=w["today"].isoformat(), due_time=hhmm(just_now))
    assert r.status_code == 201


def test_duplicate_pending_followup_is_refused_but_a_different_time_is_fine(w):
    day, t = future_slot()
    assert create(w["alice"], dealer_id=w["mine"].id, due_date=day, due_time=t).status_code == 201
    dup = create(w["alice"], dealer_id=w["mine"].id, due_date=day, due_time=t)
    assert dup.status_code == 400 and "already" in str(dup.data).lower()
    assert create(w["alice"], dealer_id=w["mine"].id, due_date=day, due_time="15:00").status_code == 201
    assert Followup.objects.count() == 2


# ───────────────────────── ordering, reschedule, summary ─────────────────────────

def test_followups_sort_by_day_then_time_with_untimed_last(w):
    d, a, mine = w["today"] + timedelta(days=2), w["a"], w["mine"]
    untimed = Followup.objects.create(dealer=mine, salesman=a, due_date=d)
    late = Followup.objects.create(dealer=mine, salesman=a, due_date=d, due_time="17:00")
    early = Followup.objects.create(dealer=mine, salesman=a, due_date=d, due_time="09:15")
    next_day = Followup.objects.create(dealer=mine, salesman=a, due_date=d + timedelta(days=1), due_time="08:00")
    got = [x["id"] for x in api(w["alice"]).get(URL + "?tab=pending").data["results"]]
    assert got == [early.id, late.id, untimed.id, next_day.id]


def test_reschedule_can_set_change_and_clear_the_time(w):
    f = Followup.objects.create(dealer=w["mine"], salesman=w["a"], due_date=w["today"] + timedelta(days=1), due_time="10:00")
    day = (w["today"] + timedelta(days=5)).isoformat()
    c = api(w["alice"])
    r = c.post(f"{URL}{f.id}/reschedule/", {"due_date": day, "due_time": "16:45"}, format="json")
    assert r.status_code == 200 and (str(r.data["due_date"]), r.data["due_time"]) == (day, "16:45")
    # No due_time in the request: the saved time is left alone.
    r = c.post(f"{URL}{f.id}/reschedule/", {"due_date": day, "priority": "low"}, format="json")
    assert r.data["due_time"] == "16:45" and r.data["priority"] == "low"
    # An explicit null clears it.
    r = c.post(f"{URL}{f.id}/reschedule/", {"due_date": day, "due_time": None}, format="json")
    assert r.status_code == 200 and r.data["due_time"] is None


def test_reschedule_to_a_past_time_today_is_refused(w):
    past = timezone.localtime() - timedelta(hours=2)
    if past.date() != w["today"]:
        pytest.skip("less than two hours into the day")
    f = Followup.objects.create(dealer=w["mine"], salesman=w["a"], due_date=w["today"] + timedelta(days=1))
    r = api(w["alice"]).post(f"{URL}{f.id}/reschedule/", {"due_date": w["today"].isoformat(), "due_time": hhmm(past)}, format="json")
    assert r.status_code == 400
    f.refresh_from_db()
    assert f.due_date == w["today"] + timedelta(days=1)  # unchanged


def test_badge_counts_only_my_pending_followups(w):
    t, a, b, mine, theirs = w["today"], w["a"], w["b"], w["mine"], w["theirs"]
    Followup.objects.create(dealer=mine, salesman=a, due_date=t - timedelta(days=3))                     # overdue
    Followup.objects.create(dealer=mine, salesman=a, due_date=t)                                         # today
    Followup.objects.create(dealer=mine, salesman=a, due_date=t, due_time="23:59")                       # today
    Followup.objects.create(dealer=mine, salesman=a, due_date=t + timedelta(days=9))                     # upcoming
    Followup.objects.create(dealer=mine, salesman=a, due_date=t - timedelta(days=1), status="completed")  # done: not counted
    Followup.objects.create(dealer=mine, salesman=a, due_date=t - timedelta(days=1), status="cancelled")  # cancelled: not counted
    Followup.objects.create(dealer=theirs, salesman=b, due_date=t)                                       # someone else's
    r = api(w["alice"]).get(URL + "summary/")
    assert r.status_code == 200
    assert r.data == {"pending": 4, "due_today": 2, "overdue": 1, "attention": 3}
    assert api(w["bob"]).get(URL + "summary/").data == {"pending": 1, "due_today": 1, "overdue": 0, "attention": 1}


def test_badge_is_zero_with_no_followups(w):
    assert api(w["alice"]).get(URL + "summary/").data == {"pending": 0, "due_today": 0, "overdue": 0, "attention": 0}


def test_completed_tab_lists_newest_first(w):
    t = w["today"]
    old = Followup.objects.create(dealer=w["mine"], salesman=w["a"], due_date=t - timedelta(days=9), status="completed")
    new = Followup.objects.create(dealer=w["mine"], salesman=w["a"], due_date=t - timedelta(days=1), status="completed")
    assert [x["id"] for x in api(w["alice"]).get(URL + "?tab=completed").data["results"]] == [new.id, old.id]


# ───────────────────────── management sees the new data ─────────────────────────

def test_management_visit_detail_shows_prices_and_total(w):
    v = Visit.objects.create(salesman=w["a"], dealer=w["mine"], visited_at=timezone.now())
    VisitOrderItem.objects.create(visit=v, product_name="Film", quantity=2, unit="roll", unit_price="100.25")
    d = api(w["admin"]).get(f"/api/management/visits/{v.id}/").data
    assert d["order"]["items"][0]["unit_price"] == pytest.approx(100.25)
    assert d["order"]["items"][0]["line_total"] == pytest.approx(200.5)
    assert d["order"]["total_amount"] == pytest.approx(200.5)


def test_management_followup_list_includes_the_time(w):
    Followup.objects.create(dealer=w["mine"], salesman=w["a"], due_date=w["today"], due_time=datetime(2000, 1, 1, 14, 5).time())
    rows = api(w["admin"]).get("/api/management/followups/").data["results"]
    assert rows[0]["due_time"] == "14:05"
