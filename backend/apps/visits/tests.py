import uuid
from datetime import timedelta

import pytest
from django.utils import timezone
from rest_framework.test import APIClient

from apps.accounts.models import Role, Salesman, User
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
    d.update(over)
    return d


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


def test_new_dealer_without_detected_location_has_none(sm):
    user, _ = sm
    r = client_for(user).post(URL, {"new_dealer": new_dealer_payload()}, format="json")
    assert r.status_code == 201, r.data
    d = Visit.objects.get(pk=r.data["visit_id"]).dealer
    assert d.latitude is None and d.longitude is None and d.location_source == ""


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
    r = client_for(user).post(URL, {"new_dealer": {"name": "SHARMA AUTO", "city": "Pune", "phone": "9222222222"}}, format="json")
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
    {"dealer_id": 1, "new_dealer": {"name": "x", "city": "y"}},
    {"new_dealer": {"name": "No Identity"}},
    {"new_dealer": {"name": "x", "city": "y", "gst_number": "BAD"}},
    {"new_dealer": {"name": "x", "city": "y", "pincode": "12"}},
    {"new_dealer": {"name": "x", "city": "y"}, "has_order": True},
    {"new_dealer": {"name": "x", "city": "y"}, "has_order": True, "order_items": [{"product_name": "a", "quantity": 0}]},
    {"new_dealer": {"name": "x", "city": "y"}, "has_order": True, "order_items": [{"quantity": 1}]},
    {"new_dealer": {"name": "x", "city": "y"}, "latitude": "10"},
    {"new_dealer": {"name": "x", "city": "y"}, "latitude": "95", "longitude": "10"},
    {"new_dealer": {"name": "x", "city": "y"}, "followup": {"due_date": "2000-01-01"}},
    {"new_dealer": {"name": "x", "city": "y"}, "visited_at": "2999-01-01T00:00:00Z"},
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
    theirs = Dealer.objects.create(name="Alpha Hidden")
    DealerOwnershipHistory.objects.create(dealer=mine, salesman=salesman)
    DealerOwnershipHistory.objects.create(dealer=theirs, salesman=bob)
    r = client_for(user).get("/api/salesman/dealers/", {"q": "alpha"})
    assert [d["name"] for d in r.data] == ["Alpha Motors"]


def test_product_list_active_only_and_searchable(sm):
    user, _ = sm
    Product.objects.create(name="Film Alpha")
    Product.objects.create(name="Film Beta", is_active=False)
    Product.objects.create(name="Polish")
    r = client_for(user).get("/api/products/", {"q": "film"})
    assert [p["name"] for p in r.data] == ["Film Alpha"]
    assert APIClient().get("/api/products/").status_code == 401
