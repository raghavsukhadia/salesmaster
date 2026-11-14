from datetime import timedelta

import pytest
from django.utils import timezone
from rest_framework.test import APIClient

from apps.accounts.models import Role, Salesman, User
from apps.dealers.models import Dealer, DealerAccessGrant, DealerOwnershipHistory
from apps.visits.models import Followup, Product, Visit, VisitOrderItem, VisitProduct

pytestmark = pytest.mark.django_db


def mk(name, role, phone=None):
    u = User.objects.create_user(name, password="x", role=role)
    return u, (Salesman.objects.create(user=u, phone_number=phone) if phone else None)


def api(u):
    c = APIClient()
    c.force_authenticate(u)
    return c


@pytest.fixture
def w():
    today = timezone.localdate()
    alice, a = mk("alice", Role.SALESMAN, "9000000001")
    bob, b = mk("bob", Role.SALESMAN, "9000000002")
    admin, _ = mk("admin", Role.ADMIN)
    mgr, _ = mk("mgr", Role.MANAGER)
    d1 = Dealer.objects.create(name="Sharma Auto", phone="9111111111", city="Pune")
    d2 = Dealer.objects.create(name="Gupta Motors", phone="9222222222", city="Delhi")
    hidden = Dealer.objects.create(name="Hidden Garage", city="Goa")
    DealerOwnershipHistory.objects.create(dealer=d1, salesman=a)
    DealerOwnershipHistory.objects.create(dealer=d2, salesman=a)
    DealerOwnershipHistory.objects.create(dealer=hidden, salesman=b)
    now = timezone.now()
    v1 = Visit.objects.create(salesman=a, dealer=d1, visited_at=now, notes="Wants film", visit_lat="18.5", visit_lng="73.8", location_source="browser")
    VisitOrderItem.objects.create(visit=v1, product_name="Sun Film", quantity=4)
    p = Product.objects.create(name="Sun Film")
    VisitProduct.objects.create(visit=v1, product=p)
    v2 = Visit.objects.create(salesman=a, dealer=d2, visited_at=now - timedelta(days=10), notes="Just hello")
    vb = Visit.objects.create(salesman=b, dealer=hidden, visited_at=now, notes="Bob only")
    f_over = Followup.objects.create(dealer=d1, salesman=a, visit=v1, due_date=today - timedelta(days=2), priority="high", notes="Call back")
    f_today = Followup.objects.create(dealer=d2, salesman=a, due_date=today)
    f_up = Followup.objects.create(dealer=d1, salesman=a, due_date=today + timedelta(days=5))
    f_done = Followup.objects.create(dealer=d1, salesman=a, due_date=today - timedelta(days=9), status="completed", outcome="interested")
    f_bob = Followup.objects.create(dealer=hidden, salesman=b, due_date=today)
    return dict(alice=alice, bob=bob, admin=admin, mgr=mgr, a=a, b=b, d1=d1, d2=d2, hidden=hidden, v1=v1, v2=v2, vb=vb,
                f_over=f_over, f_today=f_today, f_up=f_up, f_done=f_done, f_bob=f_bob, today=today)


def ids(r):
    return {x["id"] for x in r.data["results"]}


# ---------- role gating ----------

@pytest.mark.parametrize("path", ["/api/salesman/visits/", "/api/salesman/followups/"])
def test_only_salesmen(w, path):
    assert APIClient().get(path).status_code == 401
    for who in ("admin", "mgr"):
        assert api(w[who]).get(path).status_code == 403
    assert api(w["alice"]).get(path).status_code == 200


def test_user_without_salesman_profile_rejected(w):
    ghost, _ = mk("ghost", Role.SALESMAN)
    assert api(ghost).get("/api/salesman/visits/").status_code == 403
    w["a"].is_active = False
    w["a"].save()
    assert api(w["alice"]).get("/api/salesman/followups/").status_code == 403


# ---------- visit history ----------

def test_visit_list_only_own(w):
    r = api(w["alice"]).get("/api/salesman/visits/")
    assert ids(r) == {w["v1"].id, w["v2"].id} and r.data["count"] == 2
    assert r.data["summary"] == {"total": 2, "orders": 1, "last_7_days": 1}
    assert [x["id"] for x in r.data["results"]] == [w["v1"].id, w["v2"].id]  # newest first
    assert ids(api(w["bob"]).get("/api/salesman/visits/")) == {w["vb"].id}


def test_visit_list_filters(w):
    c = api(w["alice"])
    assert ids(c.get("/api/salesman/visits/", {"q": "gupta"})) == {w["v2"].id}
    assert ids(c.get("/api/salesman/visits/", {"q": "9111"})) == {w["v1"].id}
    assert ids(c.get("/api/salesman/visits/", {"q": "hello"})) == {w["v2"].id}
    assert ids(c.get("/api/salesman/visits/", {"range": "7"})) == {w["v1"].id}
    assert ids(c.get("/api/salesman/visits/", {"range": "today"})) == {w["v1"].id}
    assert ids(c.get("/api/salesman/visits/", {"order": "yes"})) == {w["v1"].id}
    assert ids(c.get("/api/salesman/visits/", {"order": "no"})) == {w["v2"].id}
    assert ids(c.get("/api/salesman/visits/", {"q": "Hidden"})) == set()


def test_summary_not_inflated_by_multiple_order_lines(w):
    for n in range(3):
        VisitOrderItem.objects.create(visit=w["v1"], product_name=f"Extra {n}", quantity=1)
    r = api(w["alice"]).get("/api/salesman/visits/")
    assert r.data["summary"] == {"total": 2, "orders": 1, "last_7_days": 1}
    assert r.data["count"] == 2


def test_visit_list_pagination(w):
    Visit.objects.bulk_create(Visit(salesman=w["a"], dealer=w["d1"], visited_at=timezone.now() - timedelta(days=20 + i)) for i in range(30))
    c = api(w["alice"])
    p1, p2 = c.get("/api/salesman/visits/"), c.get("/api/salesman/visits/", {"page": 2})
    assert p1.data["count"] == 32 and len(p1.data["results"]) == 25 and len(p2.data["results"]) == 7
    assert c.get("/api/salesman/visits/", {"page": "junk"}).status_code == 200


def test_visit_list_query_count_is_constant(w, django_assert_max_num_queries):
    Visit.objects.bulk_create(Visit(salesman=w["a"], dealer=w["d1"], visited_at=timezone.now()) for _ in range(20))
    with django_assert_max_num_queries(12):
        api(w["alice"]).get("/api/salesman/visits/")


def test_visit_detail(w):
    r = api(w["alice"]).get(f"/api/salesman/visits/{w['v1'].id}/")
    assert r.status_code == 200
    assert r.data["dealer"]["name"] == "Sharma Auto" and r.data["notes"] == "Wants film"
    assert r.data["order_items"] == [{"name": "Sun Film", "quantity": 4, "unit": "pcs", "unit_price": 0.0, "line_total": 0.0}]
    assert r.data["interests"] == ["Sun Film"]
    assert r.data["location"]["lat"] == 18.5
    assert [f["priority"] for f in r.data["followups"]] == ["high"]


def test_visit_detail_other_salesman_or_missing_is_404(w):
    assert api(w["alice"]).get(f"/api/salesman/visits/{w['vb'].id}/").status_code == 404
    assert api(w["bob"]).get(f"/api/salesman/visits/{w['v1'].id}/").status_code == 404
    assert api(w["alice"]).get("/api/salesman/visits/99999/").status_code == 404
    assert api(w["admin"]).get(f"/api/salesman/visits/{w['v1'].id}/").status_code == 403


def test_visits_hidden_when_dealer_no_longer_accessible(w):
    # dealer transferred away: the old owner loses the dealer, so its history too
    w["d1"].ownerships.update(ended_at=timezone.now())
    DealerOwnershipHistory.objects.create(dealer=w["d1"], salesman=w["b"])
    c = api(w["alice"])
    assert ids(c.get("/api/salesman/visits/")) == {w["v2"].id}
    assert c.get(f"/api/salesman/visits/{w['v1'].id}/").status_code == 404
    assert w["f_over"].id not in ids(c.get("/api/salesman/followups/"))
    # a grant restores access to the dealer but never to another salesman's visits
    DealerAccessGrant.objects.create(salesman=w["a"], dealer=w["d1"])
    assert w["v1"].id in ids(c.get("/api/salesman/visits/"))


def test_grant_does_not_expose_other_salesmans_visits(w):
    DealerAccessGrant.objects.create(salesman=w["a"], dealer=w["hidden"])
    assert w["vb"].id not in ids(api(w["alice"]).get("/api/salesman/visits/"))
    assert w["f_bob"].id not in ids(api(w["alice"]).get("/api/salesman/followups/"))


# ---------- follow-up list ----------

def fu(w, who="alice", **params):
    return api(w[who]).get("/api/salesman/followups/", params)


def test_followup_tabs_and_counts(w):
    r = fu(w)
    assert ids(r) == {w["f_over"].id, w["f_today"].id, w["f_up"].id}
    assert [x["id"] for x in r.data["results"]] == [w["f_over"].id, w["f_today"].id, w["f_up"].id]  # soonest first
    assert r.data["counts"] == {"pending": 3, "due_today": 1, "overdue": 1, "completed": 1}
    assert ids(fu(w, tab="due_today")) == {w["f_today"].id}
    assert ids(fu(w, tab="overdue")) == {w["f_over"].id}
    assert ids(fu(w, tab="completed")) == {w["f_done"].id}
    assert fu(w, tab="nope").status_code == 400


def test_followup_row_content(w):
    row = next(x for x in fu(w, tab="overdue").data["results"])
    assert row["state"] == "overdue" and row["priority"] == "high" and row["notes"] == "Call back"
    assert row["dealer"] == {"id": w["d1"].id, "name": "Sharma Auto", "phone": "9111111111", "city": "Pune"}


def test_followup_search_and_priority(w):
    assert ids(fu(w, q="gupta")) == {w["f_today"].id}
    assert ids(fu(w, q="call back")) == {w["f_over"].id}
    assert ids(fu(w, priority="high")) == {w["f_over"].id}


def test_followups_only_own(w):
    assert ids(fu(w, "bob")) == {w["f_bob"].id}
    assert fu(w, "bob").data["counts"]["pending"] == 1


# ---------- follow-up actions ----------

def act(w, f, action, who="alice", **body):
    return api(w[who]).post(f"/api/salesman/followups/{f.id}/{action}/", body, format="json")


def test_complete_with_outcome_and_notes(w):
    r = act(w, w["f_today"], "complete", outcome="call_again", notes="Spoke to owner")
    assert r.status_code == 200 and r.data["state"] == "completed"
    w["f_today"].refresh_from_db()
    assert w["f_today"].status == "completed" and w["f_today"].outcome == "call_again" and w["f_today"].notes == "Spoke to owner"
    assert fu(w).data["counts"]["pending"] == 2 and fu(w).data["counts"]["completed"] == 2


def test_complete_without_body(w):
    assert act(w, w["f_up"], "complete").status_code == 200


def test_invalid_outcome(w):
    assert act(w, w["f_up"], "complete", outcome="bogus").status_code == 400
    w["f_up"].refresh_from_db()
    assert w["f_up"].status == "pending"


def test_reschedule(w):
    new = w["today"] + timedelta(days=3)
    r = act(w, w["f_over"], "reschedule", due_date=new.isoformat(), priority="low")
    assert r.status_code == 200 and r.data["state"] == "upcoming"
    w["f_over"].refresh_from_db()
    assert w["f_over"].due_date == new and w["f_over"].priority == "low" and w["f_over"].status == "pending"
    assert fu(w).data["counts"]["overdue"] == 0


def test_reschedule_validation(w):
    past = (w["today"] - timedelta(days=1)).isoformat()
    far = (w["today"] + timedelta(days=400)).isoformat()
    assert act(w, w["f_up"], "reschedule").status_code == 400
    assert act(w, w["f_up"], "reschedule", due_date=past).status_code == 400
    assert act(w, w["f_up"], "reschedule", due_date=far).status_code == 400
    assert act(w, w["f_up"], "reschedule", due_date="not-a-date").status_code == 400
    assert act(w, w["f_up"], "reschedule", due_date=w["today"].isoformat()).status_code == 200  # today is allowed


def test_cancel_removes_from_pending(w):
    assert act(w, w["f_up"], "cancel", notes="Dealer closed").status_code == 200
    w["f_up"].refresh_from_db()
    assert w["f_up"].status == "cancelled" and w["f_up"].notes == "Dealer closed"
    assert w["f_up"].id not in ids(fu(w))
    assert w["f_up"].id not in ids(fu(w, tab="completed"))


def test_closed_followup_cannot_change_again(w):
    for action, body in (("complete", {}), ("cancel", {}), ("reschedule", {"due_date": w["today"].isoformat()})):
        assert act(w, w["f_done"], action, **body).status_code == 400
    act(w, w["f_up"], "cancel")
    assert act(w, w["f_up"], "complete").status_code == 400
    w["f_up"].refresh_from_db()
    assert w["f_up"].status == "cancelled"


def test_cannot_act_on_other_salesmans_followup(w):
    for action in ("complete", "cancel"):
        assert act(w, w["f_bob"], action).status_code == 404
    assert act(w, w["f_bob"], "reschedule", due_date=w["today"].isoformat()).status_code == 404
    w["f_bob"].refresh_from_db()
    assert w["f_bob"].status == "pending"
    assert act(w, w["f_up"], "complete", who="bob").status_code == 404


def test_cannot_act_on_followup_of_inaccessible_dealer(w):
    w["d2"].ownerships.update(ended_at=timezone.now())
    assert act(w, w["f_today"], "complete").status_code == 404


def test_unknown_action_and_roles(w):
    assert act(w, w["f_up"], "delete").status_code == 404
    for who in ("admin", "mgr"):
        assert act(w, w["f_up"], "complete", who=who).status_code == 403
    assert APIClient().post(f"/api/salesman/followups/{w['f_up'].id}/complete/").status_code == 401
    w["f_up"].refresh_from_db()
    assert w["f_up"].status == "pending"


def test_double_submit_second_call_is_rejected_not_duplicated(w):
    assert act(w, w["f_up"], "complete").status_code == 200
    assert act(w, w["f_up"], "complete").status_code == 400


def test_management_endpoints_unaffected(w):
    assert api(w["mgr"]).get("/api/management/followups/").status_code == 200
    assert api(w["mgr"]).get("/api/management/visits/").status_code == 200
