import uuid
from datetime import timedelta

import pytest
from django.utils import timezone
from rest_framework.test import APIClient

from apps.accounts.models import Role, Salesman, User
from apps.dealers.access import CREATED_VIA_VISIT
from apps.dealers.models import Dealer, DealerAccessGrant, DealerOwnershipHistory
from apps.visits.models import Followup, Product, Visit, VisitOrderItem

pytestmark = pytest.mark.django_db

URL = "/api/visits/record/"


def make_salesman(name, phone):
    user = User.objects.create_user(name, password="pw-12345-x", role=Role.SALESMAN)
    return user, Salesman.objects.create(user=user, phone_number=phone)


def client_for(user):
    c = APIClient()
    c.force_authenticate(user)
    return c


@pytest.fixture
def sm():
    return make_salesman("alice", "9000000001")


@pytest.fixture
def other():
    return make_salesman("bob", "9000000002")


def new_dealer_payload(**over):
    d = {"name": "Sharma Auto", "phone": "+91 98765 43210", "city": "Pune", "state": "MH", "contact_name": "Raj"}
    if "latitude" not in over and "longitude" not in over:  # the shop location is required; tests of it pass their own
        d.update(SHOP)
    d.update(over)
    return d


SHOP = {"latitude": "18.520400", "longitude": "73.856700", "location_accuracy_m": 15}


def tomorrow():
    return (timezone.localdate() + timedelta(days=1)).isoformat()


def test_full_workflow_new_dealer_in_one_transaction(sm):
    user, salesman = sm
    cat = Product.objects.create(name="Film A")
    payload = {
        "client_request_id": str(uuid.uuid4()),
        "new_dealer": new_dealer_payload(),
        "latitude": "18.520400", "longitude": "73.856700",
        "notes": "Wants films",
        "has_order": True,
        "order_items": [{"product_id": cat.id, "quantity": 5}, {"product_name": "Custom Tint", "quantity": 2}],
        "followup": {"due_date": tomorrow(), "priority": "high"},
    }
    r = client_for(user).post(URL, payload, format="json")
    assert r.status_code == 201, r.data
    visit = Visit.objects.get(pk=r.data["visit_id"])
    dealer = visit.dealer
    assert dealer.phone == "9876543210" and dealer.status.name == "New"
    assert DealerOwnershipHistory.objects.get(dealer=dealer, ended_at=None).salesman == salesman
    assert dealer.contacts.get().name == "Raj"
    items = {i.product_name: i for i in VisitOrderItem.objects.filter(visit=visit)}
    assert items["Film A"].product == cat and items["Film A"].unit_price == 0
    assert items["Custom Tint"].product is None
    assert Product.objects.count() == 1  # custom items never enter the catalogue
    fu = Followup.objects.get(visit=visit)
    assert fu.priority == "high" and fu.status == "pending"
    dealer.refresh_from_db()
    assert dealer.last_visit_at == visit.visited_at and str(dealer.next_followup_at) == tomorrow()
    assert visit.source == "web" and visit.location_source == "browser_gps"


def test_new_dealer_detected_location_is_stored_unverified(sm):
    user, _ = sm
    nd = new_dealer_payload(latitude="18.520400", longitude="73.856700", location_accuracy_m=12.5)
    r = client_for(user).post(URL, {"client_request_id": str(uuid.uuid4()), "new_dealer": nd}, format="json")
    assert r.status_code == 201, r.data
    d = Visit.objects.get(pk=r.data["visit_id"]).dealer
    assert (str(d.latitude), str(d.longitude), d.location_accuracy_m) == ("18.520400", "73.856700", 12.5)
    assert d.location_source == "gps_checkin"
    # A salesman can capture a pin but never verify it: that stays with management.
    assert d.location_verified_at is None and d.location_verified_by is None


def test_new_dealer_without_shop_location_is_refused_and_nothing_created(sm):
    user, _ = sm
    nd = {k: v for k, v in new_dealer_payload().items() if k not in SHOP}
    r = client_for(user).post(URL, {"new_dealer": nd}, format="json")
    assert r.status_code == 400 and "location" in r.data["new_dealer"]
    assert Dealer.objects.count() == 0 and Visit.objects.count() == 0


def test_shop_location_capture_appears_in_the_management_history(sm):
    from apps.accounts.models import Role
    from apps.accounts.models import User as U
    user, _ = sm
    r = client_for(user).post(URL, {"new_dealer": new_dealer_payload(location_accuracy_m=22)}, format="json")
    assert r.status_code == 201, r.data
    dealer = Visit.objects.get(pk=r.data["visit_id"]).dealer
    admin = U.objects.create_user("boss", password="x", role=Role.ADMIN)
    h = client_for(admin).get(f"/api/management/dealers/{dealer.id}/location/").data["history"]
    assert len(h) == 1 and h[0]["event"] == "captured" and h[0]["by_role"] == "salesman"
    assert (h[0]["latitude"], h[0]["longitude"], h[0]["accuracy_m"]) == (18.5204, 73.8567, 22.0)


@pytest.mark.parametrize("loc", [
    {"latitude": "18.5204"},                                   # one half of a pair
    {"longitude": "73.8567"},
    {"latitude": "95", "longitude": "10"},                     # out of range
    {"latitude": "10", "longitude": "181"},
    {"latitude": "abc", "longitude": "10"},
    {"latitude": "10", "longitude": "10", "location_accuracy_m": -1},
])
def test_new_dealer_bad_detected_location_rejected_and_nothing_created(sm, loc):
    user, _ = sm
    r = client_for(user).post(URL, {"new_dealer": new_dealer_payload(**loc)}, format="json")
    assert r.status_code == 400
    assert Dealer.objects.count() == 0 and Visit.objects.count() == 0


def test_existing_owned_dealer_visit_without_order(sm):
    user, salesman = sm
    d = Dealer.objects.create(name="Old", city="X")
    DealerOwnershipHistory.objects.create(dealer=d, salesman=salesman)
    r = client_for(user).post(URL, {"dealer_id": d.id, "has_order": False, "order_items": [{"product_name": "x", "quantity": 1}]}, format="json")
    assert r.status_code == 201
    assert VisitOrderItem.objects.count() == 0  # order = No discards items
    assert DealerOwnershipHistory.objects.filter(dealer=d).count() == 1


def test_visit_to_dealer_without_location_adopts_salesman_gps_unverified(sm):
    user, salesman = sm
    d = Dealer.objects.create(name="A.M. car house", city="Gwalior")
    DealerOwnershipHistory.objects.create(dealer=d, salesman=salesman)
    r = client_for(user).post(URL, {"dealer_id": d.id, "latitude": "26.218300", "longitude": "78.182800", "location_accuracy_m": 9}, format="json")
    assert r.status_code == 201, r.data
    d.refresh_from_db()
    assert (str(d.latitude), str(d.longitude), d.location_accuracy_m) == ("26.218300", "78.182800", 9.0)
    assert d.location_source == "gps_checkin" and d.location_verified_at is None
    admin = User.objects.create_user("boss", password="x", role=Role.ADMIN)
    h = client_for(admin).get(f"/api/management/dealers/{d.id}/location/").data["history"]
    assert len(h) == 1 and h[0]["event"] == "captured" and h[0]["by_role"] == "salesman"


def test_visit_never_overwrites_an_existing_dealer_location(sm):
    user, salesman = sm
    d = Dealer.objects.create(name="Located", city="X", latitude="18.520400", longitude="73.856700", location_source="manual")
    DealerOwnershipHistory.objects.create(dealer=d, salesman=salesman)
    r = client_for(user).post(URL, {"dealer_id": d.id, "latitude": "19.000000", "longitude": "74.000000"}, format="json")
    assert r.status_code == 201, r.data
    d.refresh_from_db()
    assert (str(d.latitude), str(d.longitude), d.location_source) == ("18.520400", "73.856700", "manual")


def test_granted_dealer_allowed_inaccessible_dealer_hidden(sm, other):
    user, salesman = sm
    _, bob = other
    d = Dealer.objects.create(name="Bobs Shop", city="Y")
    DealerOwnershipHistory.objects.create(dealer=d, salesman=bob)
    c = client_for(user)
    assert c.post(URL, {"dealer_id": d.id}, format="json").status_code == 404
    assert c.post(URL, {"dealer_id": 99999}, format="json").status_code == 404  # same as nonexistent
    DealerAccessGrant.objects.create(salesman=salesman, dealer=d)
    assert c.post(URL, {"dealer_id": d.id}, format="json").status_code == 201


def test_duplicate_accessible_returns_dealer(sm):
    user, salesman = sm
    d = Dealer.objects.create(name="Sharma Auto", phone="9876543210", city="Pune")
    DealerOwnershipHistory.objects.create(dealer=d, salesman=salesman)
    r = client_for(user).post(URL, {"new_dealer": new_dealer_payload(name="Different")}, format="json")
    assert r.status_code == 409 and r.data["dealer"]["id"] == d.id
    assert Visit.objects.count() == 0 and Dealer.objects.count() == 1


def test_duplicate_inaccessible_leaks_nothing(sm, other):
    user, _ = sm
    _, bob = other
    d = Dealer.objects.create(name="Secret Name", phone="9876543210", city="Pune")
    DealerOwnershipHistory.objects.create(dealer=d, salesman=bob)
    r = client_for(user).post(URL, {"new_dealer": new_dealer_payload()}, format="json")
    assert r.status_code == 409
    body = str(r.data)
    assert "This dealer is not available to you" in body
    assert "Secret" not in body and "bob" not in body and str(d.id) not in body.replace("409", "")
    assert Dealer.objects.count() == 1


@pytest.mark.parametrize("field,value", [("gst_number", "27ABCDE1234F1Z5"), ("whatsapp", "98765 43210")])
def test_duplicate_priority_gst_and_whatsapp(sm, field, value):
    user, salesman = sm
    d = Dealer.objects.create(name="Z", city="Q", gst_number="27ABCDE1234F1Z5", whatsapp="9876543210")
    DealerOwnershipHistory.objects.create(dealer=d, salesman=salesman)
    payload = new_dealer_payload(phone="", city="Other", name="Other")
    payload[field] = value
    assert client_for(user).post(URL, {"new_dealer": payload}, format="json").status_code == 409


def test_same_name_and_city_with_different_mobiles_is_allowed(sm):
    user, salesman = sm
    d = Dealer.objects.create(name="sharma auto", city="pune", phone="9111111111")
    DealerOwnershipHistory.objects.create(dealer=d, salesman=salesman)
    r = client_for(user).post(URL, {"new_dealer": {"name": "SHARMA AUTO", "city": "Pune", "phone": "9222222222", **SHOP}}, format="json")
    assert r.status_code == 201
    assert Dealer.objects.filter(name__iexact="sharma auto", city__iexact="pune").count() == 2


def test_check_duplicate_endpoint(sm, other):
    user, salesman = sm
    _, bob = other
    mine = Dealer.objects.create(name="Mine", phone="9111111111")
    theirs = Dealer.objects.create(name="Theirs", phone="9222222222")
    DealerOwnershipHistory.objects.create(dealer=mine, salesman=salesman)
    DealerOwnershipHistory.objects.create(dealer=theirs, salesman=bob)
    c = client_for(user)
    url = "/api/dealers/check-duplicate/"
    assert c.post(url, {"phone": "9333333333"}, format="json").data == {"duplicate": False}
    assert c.post(url, {"phone": "91111 11111"}, format="json").data["dealer"]["id"] == mine.id
    r = c.post(url, {"phone": "9222222222"}, format="json")
    assert r.status_code == 409 and "Theirs" not in str(r.data)


def test_idempotent_double_submit(sm):
    user, _ = sm
    payload = {"client_request_id": str(uuid.uuid4()), "new_dealer": new_dealer_payload(),
               "followup": {"due_date": tomorrow()}}
    c = client_for(user)
    first = c.post(URL, payload, format="json")
    second = c.post(URL, payload, format="json")
    assert first.status_code == 201 and second.status_code == 200
    assert first.data["visit_id"] == second.data["visit_id"]
    assert Visit.objects.count() == 1 and Dealer.objects.count() == 1 and Followup.objects.count() == 1


def test_failure_rolls_back_everything(sm, monkeypatch):
    user, _ = sm
    from apps.visits import services

    def boom(*a, **k):
        raise RuntimeError("db down")

    monkeypatch.setattr(services.Followup.objects, "create", boom)
    c = APIClient(raise_request_exception=False)
    c.force_authenticate(user)
    r = c.post(URL, {"new_dealer": new_dealer_payload(), "followup": {"due_date": tomorrow()}}, format="json")
    assert r.status_code == 500
    assert Dealer.objects.count() == 0 and Visit.objects.count() == 0
    assert DealerOwnershipHistory.objects.count() == 0


@pytest.mark.parametrize("payload", [
    {},
    {"dealer_id": 1, "new_dealer": {"name": "x", "city": "y", **SHOP}},
    {"new_dealer": {"name": "No Identity", **SHOP}},
    {"new_dealer": {"name": "x", "city": "y", "gst_number": "BAD", **SHOP}},
    {"new_dealer": {"name": "x", "city": "y", "pincode": "12", **SHOP}},
    {"new_dealer": {"name": "x", "city": "y", **SHOP}, "has_order": True},
    {"new_dealer": {"name": "x", "city": "y", **SHOP}, "has_order": True, "order_items": [{"product_name": "a", "quantity": 0}]},
    {"new_dealer": {"name": "x", "city": "y", **SHOP}, "has_order": True, "order_items": [{"quantity": 1}]},
    {"new_dealer": {"name": "x", "city": "y", **SHOP}, "latitude": "10"},
    {"new_dealer": {"name": "x", "city": "y", **SHOP}, "latitude": "95", "longitude": "10"},
    {"new_dealer": {"name": "x", "city": "y", **SHOP}, "followup": {"due_date": "2000-01-01"}},
    {"new_dealer": {"name": "x", "city": "y", **SHOP}, "followup": {"due_date": tomorrow(), "action": "other"}},
    {"new_dealer": {"name": "x", "city": "y", **SHOP}, "followup": {"due_date": tomorrow(), "action": "other", "action_text": "   "}},
    {"new_dealer": {"name": "x", "city": "y", **SHOP}, "followup": {"due_date": tomorrow(), "action": "teleport"}},
    {"new_dealer": {"name": "x", "city": "y", **SHOP}, "visited_at": "2999-01-01T00:00:00Z"},
])
def test_validation_errors_create_nothing(sm, payload):
    user, _ = sm
    r = client_for(user).post(URL, payload, format="json")
    assert r.status_code == 400, r.data
    assert Dealer.objects.count() == 0 and Visit.objects.count() == 0


def test_inactive_or_unknown_product_rejected(sm):
    user, _ = sm
    inactive = Product.objects.create(name="Old", is_active=False)
    for pid in (inactive.id, 9999):
        r = client_for(user).post(URL, {"new_dealer": new_dealer_payload(), "has_order": True,
                                        "order_items": [{"product_id": pid, "quantity": 1}]}, format="json")
        assert r.status_code == 400
    assert Dealer.objects.count() == 0


def test_role_and_auth_enforced(sm):
    mgr = User.objects.create_user("m", password="x", role=Role.MANAGER)
    assert client_for(mgr).post(URL, {}, format="json").status_code == 403
    assert APIClient().post(URL, {}, format="json").status_code == 401
    ghost = User.objects.create_user("ghost", password="x", role=Role.SALESMAN)
    r = client_for(ghost).post(URL, {"new_dealer": new_dealer_payload()}, format="json")
    assert r.status_code == 403


def test_inactive_salesman_blocked(sm):
    user, salesman = sm
    salesman.is_active = False
    salesman.save()
    assert client_for(user).post(URL, {"new_dealer": new_dealer_payload()}, format="json").status_code == 403


def test_dealer_search_scoped_to_access(sm, other):
    user, salesman = sm
    _, bob = other
    mine = Dealer.objects.create(name="Alpha Motors")
    assigned = Dealer.objects.create(name="Alpha Imported")
    theirs = Dealer.objects.create(name="Alpha Hidden")
    DealerOwnershipHistory.objects.create(dealer=mine, salesman=salesman, reason=CREATED_VIA_VISIT)
    DealerOwnershipHistory.objects.create(dealer=assigned, salesman=salesman, reason="Imported")
    DealerOwnershipHistory.objects.create(dealer=theirs, salesman=bob, reason=CREATED_VIA_VISIT)
    r = client_for(user).get("/api/salesman/dealers/", {"q": "alpha"})
    # Only dealers the salesman added; an admin-assigned (imported) dealer is not listed even though they own it.
    assert [d["name"] for d in r.data] == ["Alpha Motors"]


def test_dealer_search_drops_self_added_dealer_after_transfer(sm, other):
    user, salesman = sm
    _, bob = other
    d = Dealer.objects.create(name="Moved Motors")
    DealerOwnershipHistory.objects.create(dealer=d, salesman=salesman, reason=CREATED_VIA_VISIT, ended_at=timezone.now())
    DealerOwnershipHistory.objects.create(dealer=d, salesman=bob, reason="Transfer")
    assert client_for(user).get("/api/salesman/dealers/", {"q": "moved"}).data == []


def test_product_list_active_only_and_searchable(sm):
    user, _ = sm
    Product.objects.create(name="Film Alpha")
    Product.objects.create(name="Film Beta", is_active=False)
    Product.objects.create(name="Polish")
    r = client_for(user).get("/api/products/", {"q": "film"})
    assert [p["name"] for p in r.data] == ["Film Alpha"]
    assert APIClient().get("/api/products/").status_code == 401


def record_with_followup(user, followup):
    r = client_for(user).post(URL, {"new_dealer": new_dealer_payload(), "followup": followup}, format="json")
    assert r.status_code == 201, r.data
    return Followup.objects.get(visit_id=r.data["visit_id"]), r.data["visit_id"]


def test_followup_keeps_the_chosen_action_and_shows_it_as_the_task(sm):
    user, _ = sm
    fu, visit_id = record_with_followup(user, {"due_date": tomorrow(), "action": "send_quotation", "notes": "Revised PPF pricing"})
    assert (fu.action, fu.action_text, fu.task, fu.notes) == ("send_quotation", "", "Send quotation", "Revised PPF pricing")
    c = client_for(user)
    detail = c.get(f"/api/salesman/visits/{visit_id}/")
    assert [(f["action"], f["task"]) for f in detail.data["followups"]] == [("send_quotation", "Send quotation")]
    assert c.get("/api/salesman/followups/").data["results"][0]["task"] == "Send quotation"


def test_other_action_uses_the_typed_text_as_the_task(sm):
    user, _ = sm
    fu, _ = record_with_followup(user, {"due_date": tomorrow(), "action": "other", "action_text": "  Confirm installation date "})
    assert (fu.action, fu.action_text, fu.task) == ("other", "Confirm installation date", "Confirm installation date")


def test_text_is_dropped_when_the_action_is_not_other(sm):
    user, _ = sm
    fu, _ = record_with_followup(user, {"due_date": tomorrow(), "action": "call_dealer", "action_text": "something else"})
    assert (fu.action_text, fu.task) == ("", "Call dealer")


def test_followup_without_an_action_still_works_and_has_no_task(sm):
    # Older clients and field check-ins send no action; the follow-up is still created.
    user, _ = sm
    fu, visit_id = record_with_followup(user, {"due_date": tomorrow()})
    assert (fu.action, fu.action_text, fu.task) == ("", "", "")
    assert client_for(user).get(f"/api/salesman/visits/{visit_id}/").data["followups"][0]["task"] == ""
