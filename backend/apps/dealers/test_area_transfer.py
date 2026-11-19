"""Dealer entry rules, area (state) transfers between salesmen, and what the new salesman inherits.

The rule everything here protects: transferring an area moves OWNERSHIP only. Orders that already exist keep the
salesman who recorded them, byte for byte; only orders recorded after the transfer carry the new salesman.
"""
from datetime import timedelta

import pytest
from django.utils import timezone
from rest_framework.test import APIClient

from apps.accounts.models import Role, Salesman, SalesmanTerritory, User
from apps.dealers.models import Dealer, DealerAccessGrant, DealerOwnershipHistory
from apps.visits.models import Followup, Visit, VisitOrderItem

pytestmark = pytest.mark.django_db

TRANSFER = "/api/management/transfers/"
PREVIEW = "/api/management/transfers/preview/"
RECORD = "/api/visits/record/"


def mk(name, role=Role.SALESMAN, phone=None):
    u = User.objects.create_user(name, f"{name}@x.com", "pw-12345-abc", role=role, first_name=name.title())
    return u, (Salesman.objects.create(user=u, phone_number=phone) if phone else None)


def api(user):
    c = APIClient()
    c.force_authenticate(user)
    return c


def dealer(name, owner=None, state="Maharashtra", city="Pune", **kw):
    d = Dealer.objects.create(name=name, state=state, city=city, **kw)
    if owner:
        DealerOwnershipHistory.objects.create(dealer=d, salesman=owner)
    return d


def owner_of(d):
    o = DealerOwnershipHistory.objects.filter(dealer=d, ended_at=None).first()
    return o.salesman if o else None


def order(salesman, d, items=(("HD 70", 5),), days_ago=3):
    v = Visit.objects.create(salesman=salesman, dealer=d, visited_at=timezone.now() - timedelta(days=days_ago))
    for name, qty in items:
        VisitOrderItem.objects.create(visit=v, product_name=name, quantity=qty)
    return v


def snapshot():
    """Every visit and order line exactly as stored."""
    return list(Visit.objects.order_by("id").values()), list(VisitOrderItem.objects.order_by("id").values())


@pytest.fixture
def w():
    admin, _ = mk("admin", Role.ADMIN)
    mgr, _ = mk("mgr", Role.MANAGER)
    ru, rakesh = mk("rakesh", phone="9000000001")
    au, amit = mk("amit", phone="9000000002")
    bu, bina = mk("bina", phone="9000000003")
    return dict(admin=admin, mgr=mgr, ru=ru, rakesh=rakesh, au=au, amit=amit, bu=bu, bina=bina)


@pytest.fixture
def maharashtra(w):
    """Rakesh holds Maharashtra (two Pune dealers, one Mumbai) plus one Gujarat dealer; Bina holds one Maharashtra dealer."""
    r = w["rakesh"]
    d = {
        "pune1": dealer("Sharma Auto", r, city="Pune"),
        "pune2": dealer("Patil Motors", r, city="Pune"),
        "mumbai": dealer("Kapoor Films", r, city="Mumbai"),
        "surat": dealer("Desai Tints", r, state="Gujarat", city="Surat"),
        "bina": dealer("Bina's Shop", w["bina"], city="Nashik"),
    }
    d["v_pune1"] = order(r, d["pune1"], (("HD 70", 5), ("HD 90", 2)), days_ago=10)
    d["v_pune2"] = order(r, d["pune2"], (("HD 70", 1),), days_ago=6)
    d["v_mumbai"] = order(r, d["mumbai"], (("Ultra 50", 8),), days_ago=2)
    d["v_surat"] = order(r, d["surat"], (("HD 70", 3),))
    d["v_bina"] = order(w["bina"], d["bina"], (("HD 70", 9),))
    return d


def move_maharashtra(w, **kw):
    body = {"mode": "owner_state", "owner_id": w["rakesh"].id, "state": "Maharashtra", "to_salesman_id": w["amit"].id}
    body.update(kw)
    return api(w["admin"]).post(TRANSFER, body, format="json")


# =============================== 1. Dealer entry: names may repeat, mobiles may not ===============================

def new_dealer(**over):
    d = {"name": "Sharma Auto", "phone": "9111111111", "city": "Pune", "state": "Maharashtra", "latitude": "18.5204", "longitude": "73.8567"}
    d.update(over)
    return {"new_dealer": d}


def test_two_dealers_may_share_a_name_and_city_but_not_a_mobile(w):
    c = api(w["ru"])
    assert c.post(RECORD, new_dealer(), format="json").status_code == 201
    second = c.post(RECORD, new_dealer(phone="9222222222"), format="json")
    assert second.status_code == 201, second.data
    assert Dealer.objects.filter(name="Sharma Auto", city="Pune").count() == 2

    # The same mobile in any spelling is refused, whatever the name.
    for spelling in ("9111111111", "+91 91111-11111", "09111111111"):
        r = c.post(RECORD, new_dealer(name="Totally Different", city="Delhi", phone=spelling), format="json")
        assert r.status_code == 409 and r.data["code"] == "duplicate_dealer", spelling
    assert Dealer.objects.count() == 2


def test_duplicate_check_ignores_names_and_matches_on_mobile(w):
    dealer("Sharma Auto", w["rakesh"], phone="9111111111")
    c, url = api(w["ru"]), "/api/dealers/check-duplicate/"
    assert c.post(url, {"name": "Sharma Auto", "city": "Pune"}, format="json").data == {"duplicate": False}
    assert c.post(url, {"name": "Sharma Auto", "city": "Pune", "phone": "9222222222"}, format="json").data == {"duplicate": False}
    assert c.post(url, {"name": "Whatever", "phone": "91111 11111"}, format="json").data["duplicate"] is True


def test_a_whatsapp_number_cannot_reuse_another_dealers_mobile(w):
    dealer("Sharma Auto", w["rakesh"], phone="9111111111")
    r = api(w["ru"]).post(RECORD, new_dealer(phone="9222222222", whatsapp="9111111111"), format="json")
    assert r.status_code == 409


def test_editing_a_dealer_keeps_mobiles_unique_but_not_names(w):
    a = dealer("Sharma Auto", w["rakesh"], phone="9111111111", whatsapp="9111111100")
    b = dealer("Patil Motors", w["rakesh"], phone="9222222222")
    admin = api(w["admin"])
    # A name may repeat.
    assert admin.patch(f"/api/dealers/{b.id}/", {"name": "Sharma Auto"}, format="json").status_code == 200
    # A mobile or WhatsApp number may not clash with another dealer's mobile or WhatsApp.
    assert admin.patch(f"/api/dealers/{b.id}/", {"phone": "+91 91111 11111"}, format="json").status_code == 400
    r = admin.patch(f"/api/dealers/{b.id}/", {"whatsapp": "9111111111"}, format="json")
    assert r.status_code == 400 and "whatsapp" in r.data
    assert admin.patch(f"/api/dealers/{b.id}/", {"whatsapp": "9111111100"}, format="json").status_code == 400
    b.refresh_from_db()
    assert (b.phone, b.whatsapp) == ("9222222222", "")
    assert a.phone == "9111111111"


def test_an_unchanged_shared_whatsapp_never_blocks_other_edits(w):
    """Older data may already share a WhatsApp number; the edit form re-sends it on every save."""
    dealer("A", w["rakesh"], phone="9111111111", whatsapp="9333333333")
    b = dealer("B", w["rakesh"], phone="9222222222", whatsapp="9333333333")
    r = api(w["admin"]).patch(f"/api/dealers/{b.id}/", {"whatsapp": "9333333333", "city": "Nagpur"}, format="json")
    assert r.status_code == 200 and Dealer.objects.get(pk=b.pk).city == "Nagpur"


# =============================== 2 + 3. Area transfer; the new salesman inherits everything ===============================

def test_state_transfer_moves_dealers_and_never_touches_past_orders(w, maharashtra):
    before = snapshot()
    r = move_maharashtra(w, reason="territory_change")
    assert r.status_code == 201 and r.data["transferred"] == 3

    # Ownership moved for exactly Rakesh's Maharashtra dealers...
    for key in ("pune1", "pune2", "mumbai"):
        assert owner_of(maharashtra[key]) == w["amit"]
    assert owner_of(maharashtra["surat"]) == w["rakesh"]   # other state stays
    assert owner_of(maharashtra["bina"]) == w["bina"]      # someone else's dealer stays
    # ...with the previous ownership kept as history.
    old = DealerOwnershipHistory.objects.get(dealer=maharashtra["pune1"], salesman=w["rakesh"])
    assert old.ended_at is not None

    # Not one visit or order line changed: same rows, same salesman on each.
    assert snapshot() == before
    for key in ("v_pune1", "v_pune2", "v_mumbai", "v_surat"):
        assert Visit.objects.get(pk=maharashtra[key].pk).salesman == w["rakesh"]


def test_new_salesman_sees_every_dealer_with_old_orders_and_their_original_names(w, maharashtra):
    move_maharashtra(w)
    amit = api(w["au"])

    listing = amit.get("/api/salesman/dealer-list/").data
    assert listing["count"] == 3
    by_name = {d["name"]: d for d in listing["results"]}
    assert set(by_name) == {"Sharma Auto", "Patil Motors", "Kapoor Films"}
    assert by_name["Sharma Auto"]["orders"] == 1 and by_name["Kapoor Films"]["orders"] == 1
    assert all(d["mine"] for d in listing["results"])

    # Each dealer's order history shows who originally took every order, and that it is not the viewer's.
    orders = amit.get(f"/api/dealers/{maharashtra['pune1'].id}/orders/").data
    assert orders["count"] == 1
    row = orders["results"][0]
    assert row["salesman"] == "Rakesh" and row["mine"] is False
    assert {(i["name"], i["quantity"]) for i in row["items"]} == {("HD 70", 5), ("HD 90", 2)}
    assert all(i["unit"] == "pcs" for i in row["items"])
    assert amit.get(f"/api/dealers/{maharashtra['pune1'].id}/").status_code == 200

    # The previous salesman no longer sees the transferred dealers; Gujarat is still his.
    rakesh = api(w["ru"])
    assert {d["name"] for d in rakesh.get("/api/salesman/dealer-list/").data["results"]} == {"Desai Tints"}
    assert rakesh.get(f"/api/dealers/{maharashtra['pune1'].id}/").status_code == 404
    assert rakesh.get(f"/api/dealers/{maharashtra['pune1'].id}/orders/").status_code == 404


def test_new_salesman_sees_the_assigned_area_with_cities_and_order_counts(w, maharashtra):
    move_maharashtra(w)
    data = api(w["au"]).get("/api/salesman/areas/").data
    assert data["dealers"] == 3
    [area] = data["areas"]
    assert area["state"] == "Maharashtra" and area["key"] == "Maharashtra" and area["dealers"] == 3 and area["orders"] == 3
    assert area["cities"] == [{"city": "Mumbai", "dealers": 1}, {"city": "Pune", "dealers": 2}]
    # Before the transfer Amit had nothing; Rakesh now only has Gujarat.
    assert [a["state"] for a in api(w["ru"]).get("/api/salesman/areas/").data["areas"]] == ["Gujarat"]


def test_orders_after_the_transfer_carry_the_new_salesman_and_old_ones_keep_rakesh(w, maharashtra):
    move_maharashtra(w)
    d = maharashtra["pune1"]
    r = api(w["au"]).post(RECORD, {"dealer_id": d.id, "has_order": True, "order_items": [{"product_name": "HD 70", "quantity": 4}]}, format="json")
    assert r.status_code == 201
    rows = api(w["au"]).get(f"/api/dealers/{d.id}/orders/").data["results"]
    assert [(x["salesman"], x["mine"]) for x in rows] == [("Amit", True), ("Rakesh", False)]  # newest first
    assert Visit.objects.get(pk=maharashtra["v_pune1"].pk).salesman == w["rakesh"]
    # Management sees the same attribution.
    admin_rows = api(w["admin"]).get(f"/api/dealers/{d.id}/orders/").data["results"]
    assert [x["salesman"] for x in admin_rows] == ["Amit", "Rakesh"]


def test_original_salesman_name_survives_profile_rename_and_transfer(w, maharashtra):
    d, v = maharashtra["pune1"], maharashtra["v_pune1"]
    w["ru"].first_name = "Renamed Salesman"
    w["ru"].username = "renamed-r"
    w["ru"].save(update_fields=["first_name", "username"])
    assert move_maharashtra(w).status_code == 201
    row = api(w["au"]).get(f"/api/dealers/{d.id}/orders/").data["results"][0]
    assert row["salesman"] == "Rakesh" and row["mine"] is False
    admin = api(w["admin"])
    assert admin.get(f"/api/management/visits/{v.id}/").data["salesman"]["name"] == "Rakesh"
    assert next(x for x in admin.get("/api/management/visits/?range=all").data["results"] if x["id"] == v.id)["salesman"] == "Rakesh"
    assert admin.get("/api/management/visits/", {"range": "all", "q": "Rakesh"}).data["count"] == 4
    report = admin.get("/api/reports/order-wise/", {"preset": "all", "q": "Rakesh"})
    assert report.status_code == 200
    rows = next(t for t in report.data["tables"] if t["id"] == "orders")["rows"]
    assert len(rows) == 4 and all(x["salesman"] == "Rakesh" for x in rows)

    # Future orders use the new creator's name as it was at creation, independent of earlier snapshots.
    w["au"].first_name = "Amit New"
    w["au"].save(update_fields=["first_name"])
    r = api(w["au"]).post(RECORD, {"dealer_id": d.id, "has_order": True, "order_items": [{"product_name": "HD 70", "quantity": 2}]}, format="json")
    assert r.status_code == 201
    assert [x["salesman"] for x in api(w["au"]).get(f"/api/dealers/{d.id}/orders/").data["results"]] == ["Amit New", "Rakesh"]
    v.refresh_from_db()
    assert v.salesman_name == "Rakesh" and v.salesman_id == w["rakesh"].id


def test_original_salesman_name_cannot_be_rewritten(w, maharashtra):
    v = maharashtra["v_pune1"]
    v.salesman_name = "Amit"
    with pytest.raises(ValueError, match="original salesman name"):
        v.save()
    v.refresh_from_db()
    assert v.salesman_name == "Rakesh"


def test_record_visit_uses_authenticated_creator_and_never_client_attribution(w):
    d = dealer("Dealer", w["amit"])
    r = api(w["au"]).post(RECORD, {
        "dealer_id": d.id, "salesman_id": w["rakesh"].id, "salesman_name": "Rakesh",
        "has_order": True, "order_items": [{"product_name": "HD 70", "quantity": 1}],
    }, format="json")
    assert r.status_code == 201
    [v] = list(d.visits.all())
    assert (v.salesman_id, v.salesman_name) == (w["amit"].id, "Amit")


def test_dealer_list_filters_search_blank_state_and_paging(w):
    amit = w["amit"]
    dealer("Sharma Auto", amit, city="Pune", phone="9111111111")
    dealer("Patil Motors", amit, city="Nagpur", phone="9222222222")
    dealer("Stateless", amit, state="", city="")
    dealer("Hidden", amit, is_archived=True)
    someone_elses = dealer("Not mine", w["bina"])
    shared = dealer("Shared", w["bina"], city="Pune")
    DealerAccessGrant.objects.create(salesman=amit, dealer=shared)
    c = api(w["au"])
    get = lambda **q: c.get("/api/salesman/dealer-list/", q).data  # noqa: E731

    names = lambda data: [d["name"] for d in data["results"]]  # noqa: E731
    assert names(get()) == ["Patil Motors", "Shared", "Sharma Auto", "Stateless"]  # archived + others' hidden
    assert names(get(state="maharashtra", city="pune")) == ["Shared", "Sharma Auto"]
    assert names(get(q="9222")) == ["Patil Motors"]
    assert names(get(state="__none__")) == ["Stateless"]
    shared_row = next(d for d in get()["results"] if d["name"] == "Shared")
    assert shared_row["mine"] is False and all(d["mine"] for d in get()["results"] if d["name"] != "Shared")
    assert someone_elses.id not in [d["id"] for d in get()["results"]]
    assert get(page="2")["results"] == [] and get(page="2")["count"] == 4


def test_salesman_dealer_endpoints_are_for_salesmen_only(w):
    for url in ("/api/salesman/areas/", "/api/salesman/dealer-list/"):
        assert api(w["admin"]).get(url).status_code == 403
        assert api(w["mgr"]).get(url).status_code == 403
        assert APIClient().get(url).status_code == 401
        assert api(w["au"]).get(url).status_code == 200


# =============================== 5. Old history is read-only ===============================

def test_salesman_cannot_edit_a_dealer_beyond_name_and_address_or_its_order_history(w, maharashtra):
    move_maharashtra(w)
    before = snapshot()
    d = maharashtra["pune1"]
    phone = Dealer.objects.get(pk=d.pk).phone
    amit = api(w["au"])  # the new owner after the transfer
    assert amit.patch(f"/api/dealers/{d.id}/", {"phone": "9000099999"}, format="json").status_code == 403
    assert amit.patch(f"/api/dealers/{d.id}/", {"name": "Sharma Auto Care", "phone": "9000099999"}, format="json").status_code == 403
    # The previous owner lost the right to edit along with the dealer.
    assert api(w["ru"]).patch(f"/api/dealers/{d.id}/", {"name": "Hacked"}, format="json").status_code in (403, 404)
    assert Dealer.objects.get(pk=d.pk).name == "Sharma Auto"
    assert amit.post(f"/api/dealers/{d.id}/transfer/", {"salesman_id": w["bina"].id}, format="json").status_code == 403
    assert amit.post(f"/api/dealers/{d.id}/grants/", {"salesman_id": w["bina"].id}, format="json").status_code == 403
    assert amit.post(TRANSFER, {"mode": "owner_state", "owner_id": w["amit"].id, "state": "Maharashtra", "to_salesman_id": w["bina"].id}, format="json").status_code == 403
    for method in ("put", "patch", "delete", "post"):
        # Neither the previous salesman's visits nor the viewer's own can be rewritten or removed.
        for pk in (maharashtra["v_pune1"].pk, maharashtra["v_bina"].pk):
            assert getattr(amit, method)(f"/api/salesman/visits/{pk}/", {"notes": "x"}, format="json").status_code == 405
    # The owner may correct the name; that never touches the phone or any recorded visit and order line.
    assert amit.patch(f"/api/dealers/{d.id}/", {"name": "Sharma Auto Care"}, format="json").status_code == 200
    now = Dealer.objects.get(pk=d.pk)
    assert now.name == "Sharma Auto Care" and now.phone == phone
    assert snapshot() == before


def test_a_recorded_visit_can_never_be_given_to_another_salesman(w, maharashtra):
    v = Visit.objects.get(pk=maharashtra["v_pune1"].pk)
    v.salesman = w["amit"]
    with pytest.raises(ValueError):
        v.save()
    v.refresh_from_db()
    assert v.salesman == w["rakesh"]
    v.notes = "Called back"          # ordinary edits of a visit are untouched
    v.save()
    v.save(update_fields=["notes"])
    assert Visit.objects.get(pk=v.pk).notes == "Called back"


# =============================== 6. Admin transfer: preview, territories, areas picker ===============================

def test_preview_reports_the_past_orders_that_will_stay_put(w, maharashtra):
    Followup.objects.create(dealer=maharashtra["pune1"], salesman=w["rakesh"], due_date=timezone.localdate(), status="pending")
    SalesmanTerritory.objects.create(salesman=w["rakesh"], state="Maharashtra")
    r = api(w["admin"]).post(PREVIEW, {"mode": "owner_state", "owner_id": w["rakesh"].id, "state": "Maharashtra", "to_salesman_id": w["amit"].id}, format="json")
    assert r.status_code == 200
    assert r.data["dealers"] == 3 and r.data["past_orders"] == 3 and r.data["open_followups"] == 1
    assert r.data["territories"] == ["Maharashtra"] and r.data["new_owner"] == "Amit"
    assert owner_of(maharashtra["pune1"]) == w["rakesh"]  # a preview changes nothing


def test_state_transfer_moves_the_territory_label_with_it(w, maharashtra):
    r = w["rakesh"]
    SalesmanTerritory.objects.create(salesman=r, state="Maharashtra")
    SalesmanTerritory.objects.create(salesman=r, state="Maharashtra", city="Pune")
    SalesmanTerritory.objects.create(salesman=r, state="Gujarat", city="Surat")
    SalesmanTerritory.objects.create(salesman=w["amit"], state="maharashtra", city="pune")  # already has this one
    res = move_maharashtra(w)
    assert res.data["territories_moved"] == 2
    left = {(t.state, t.city) for t in r.territories.all()}
    assert left == {("Gujarat", "Surat")}
    got = {(t.state.lower(), t.city.lower()) for t in w["amit"].territories.all()}
    assert got == {("maharashtra", ""), ("maharashtra", "pune")}
    assert w["amit"].territories.count() == 2  # no duplicate Pune row


def test_territories_do_not_move_on_a_single_dealer_transfer(w, maharashtra):
    SalesmanTerritory.objects.create(salesman=w["rakesh"], state="Maharashtra")
    res = api(w["admin"]).post(TRANSFER, {"mode": "dealer", "dealer_id": maharashtra["pune1"].id, "to_salesman_id": w["amit"].id}, format="json")
    assert res.status_code == 201 and res.data["territories_moved"] == 0
    assert w["rakesh"].territories.count() == 1 and w["amit"].territories.count() == 0


def test_an_assigned_territory_with_no_dealers_yet_still_shows_as_an_area(w):
    SalesmanTerritory.objects.create(salesman=w["amit"], state="Karnataka", city="Mysuru")
    dealer("Sharma Auto", w["amit"])
    areas = {a["state"]: a for a in api(w["au"]).get("/api/salesman/areas/").data["areas"]}
    assert areas["Karnataka"]["dealers"] == 0 and areas["Karnataka"]["cities"] == [{"city": "Mysuru", "dealers": 0}]
    assert areas["Maharashtra"]["dealers"] == 1


def test_areas_picker_lists_the_states_a_salesman_holds(w, maharashtra):
    dealer("Lower", w["rakesh"], state="maharashtra", city="Pune")      # same state, different spelling
    dealer("Archived", w["rakesh"], state="Goa", is_archived=True)      # not transferable, so not offered
    dealer("No state", w["rakesh"], state="")
    r = api(w["admin"]).get("/api/management/areas/", {"owner_id": w["rakesh"].id})
    assert r.status_code == 200
    assert r.data["areas"] == [
        {"state": "Gujarat", "dealers": 1, "orders": 1},
        {"state": "Maharashtra", "dealers": 4, "orders": 3},
    ]
    assert api(w["mgr"]).get("/api/management/areas/", {"owner_id": w["rakesh"].id}).status_code == 200  # read-only: managers may look
    assert api(w["au"]).get("/api/management/areas/", {"owner_id": w["rakesh"].id}).status_code == 403
    assert api(w["admin"]).get("/api/management/areas/").status_code == 400
    assert api(w["admin"]).get("/api/management/areas/", {"owner_id": "9999"}).status_code == 400


def test_only_admins_can_transfer_an_area(w, maharashtra):
    assert api(w["mgr"]).post(TRANSFER, {"mode": "owner_state", "owner_id": w["rakesh"].id, "state": "Maharashtra", "to_salesman_id": w["amit"].id}, format="json").status_code == 403
    assert owner_of(maharashtra["pune1"]) == w["rakesh"]


def test_transferring_to_an_inactive_salesman_or_back_to_the_owner_is_refused_and_changes_nothing(w, maharashtra):
    before = snapshot()
    w["amit"].is_active = False
    w["amit"].save()
    assert move_maharashtra(w).status_code == 400
    assert move_maharashtra(w, to_salesman_id=w["rakesh"].id).status_code == 400
    assert owner_of(maharashtra["pune1"]) == w["rakesh"] and snapshot() == before
