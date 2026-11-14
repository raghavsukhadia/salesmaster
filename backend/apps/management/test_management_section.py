import io
from datetime import timedelta

import pytest
from django.utils import timezone
from openpyxl import Workbook
from rest_framework.test import APIClient

from apps.accounts.models import Role, Salesman, User
from apps.dealers.access import accessible_dealers
from apps.dealers.models import Dealer, DealerAccessGrant, DealerOwnershipHistory
from apps.visits.models import Followup, Product

pytestmark = pytest.mark.django_db


def mk(name, role=Role.SALESMAN, phone=None):
    u = User.objects.create_user(name, f"{name}@x.com", "pw-12345-abc", role=role, first_name=name.title())
    return u, (Salesman.objects.create(user=u, phone_number=phone) if phone else None)


def api(user):
    c = APIClient()
    c.force_authenticate(user)
    return c


def dealer(name, owner=None, state="MH", city="Pune", **kw):
    d = Dealer.objects.create(name=name, state=state, city=city, **kw)
    if owner:
        DealerOwnershipHistory.objects.create(dealer=d, salesman=owner)
    return d


def owner_of(d):
    o = DealerOwnershipHistory.objects.filter(dealer=d, ended_at=None).first()
    return o.salesman if o else None


@pytest.fixture
def w():
    admin, _ = mk("admin", Role.ADMIN)
    mgr, _ = mk("mgr", Role.MANAGER)
    au, a = mk("alice", phone="9000000001")
    bu, b = mk("bob", phone="9000000002")
    cu, c = mk("carl", phone="9000000003")
    return dict(admin=admin, mgr=mgr, au=au, a=a, bu=bu, b=b, cu=cu, c=c)


# ================================ Products ================================

def test_product_list_summary_search_and_status(w):
    Product.objects.create(name="SK50", category="Film")
    Product.objects.create(name="HD 70", is_active=False, description="premium")
    r = api(w["mgr"]).get("/api/management/products/")
    assert r.status_code == 200 and r.data["summary"] == {"total": 2, "active": 1, "inactive": 1}
    assert [p["name"] for p in r.data["results"]] == ["HD 70", "SK50"]
    assert api(w["mgr"]).get("/api/management/products/?q=premium").data["count"] == 1
    assert api(w["mgr"]).get("/api/management/products/?status=active").data["count"] == 1
    assert api(w["mgr"]).get("/api/management/products/?status=inactive").data["results"][0]["name"] == "HD 70"


def test_product_endpoints_are_management_only(w):
    assert api(w["au"]).get("/api/management/products/").status_code == 403
    assert api(w["au"]).post("/api/management/products/", {"name": "X"}, format="json").status_code == 403
    assert APIClient().get("/api/management/products/").status_code == 401


@pytest.mark.parametrize("who", ["admin", "mgr"])
def test_create_edit_deactivate_product(w, who):
    c = api(w[who])
    r = c.post("/api/management/products/", {"name": "  SK  70 ", "category": "Film"}, format="json")
    assert r.status_code == 201 and r.data["name"] == "SK 70" and r.data["is_active"] is True
    pid = r.data["id"]
    r = c.patch(f"/api/management/products/{pid}/", {"description": "Dark film"}, format="json")
    assert r.status_code == 200 and r.data["description"] == "Dark film"
    r = c.patch(f"/api/management/products/{pid}/", {"is_active": False}, format="json")
    assert r.data["is_active"] is False
    # Deactivated products leave the salesman order picker.
    assert api(w["au"]).get("/api/products/").data == []


def test_duplicate_product_name_blocked_case_insensitively(w):
    c = api(w["admin"])
    Product.objects.create(name="SK50")
    r = c.post("/api/management/products/", {"name": "sk50"}, format="json")
    assert r.status_code == 400 and "already exists" in r.data["name"]
    other = Product.objects.create(name="SK70")
    r = c.patch(f"/api/management/products/{other.id}/", {"name": "Sk50"}, format="json")
    assert r.status_code == 400
    # Keeping its own name is fine.
    assert c.patch(f"/api/management/products/{other.id}/", {"name": "SK70", "category": "x"}, format="json").status_code == 200


def test_product_validation_and_not_found(w):
    c = api(w["admin"])
    assert c.post("/api/management/products/", {"name": "   "}, format="json").status_code == 400
    assert c.post("/api/management/products/", {}, format="json").status_code == 400
    assert c.patch("/api/management/products/9999/", {"name": "x"}, format="json").status_code == 404
    assert c.delete("/api/management/products/1/").status_code == 405  # deactivate, never delete


def test_product_updated_at_changes_on_edit(w):
    p = Product.objects.create(name="A")
    Product.objects.filter(pk=p.pk).update(updated_at=timezone.now() - timedelta(days=30))
    before = Product.objects.get(pk=p.pk).updated_at
    api(w["admin"]).patch(f"/api/management/products/{p.id}/", {"category": "New"}, format="json")
    assert Product.objects.get(pk=p.pk).updated_at > before


def _xlsx(rows):
    wb = Workbook()
    ws = wb.active
    for r in rows:
        ws.append(r)
    buf = io.BytesIO()
    wb.save(buf)
    buf.seek(0)
    buf.name = "products.xlsx"
    return buf


def test_import_xlsx_adds_new_skips_duplicates_and_invalid(w):
    Product.objects.create(name="Existing", category="Keep")
    f = _xlsx([["Name", "Category", "Description"], ["Alpha", "Film", "d"], ["existing", "Changed", ""],
               ["ALPHA", "", ""], ["", "x", ""], ["Beta", None, None]])
    r = api(w["mgr"]).post("/api/management/products/import/", {"file": f}, format="multipart")
    assert r.status_code == 200, r.data
    assert r.data["created"] == 2 and r.data["skipped_count"] == 2 and r.data["invalid_count"] == 1
    assert set(Product.objects.values_list("name", flat=True)) == {"Existing", "Alpha", "Beta"}
    assert Product.objects.get(name="Existing").category == "Keep"  # never overwritten


def test_import_csv_and_rejections(w):
    c = api(w["admin"])
    csv_file = io.BytesIO(b"name,category\nGamma,Film\n")
    csv_file.name = "p.csv"
    assert c.post("/api/management/products/import/", {"file": csv_file}, format="multipart").data["created"] == 1
    bad = io.BytesIO(b"title\nx\n")
    bad.name = "p.csv"
    assert c.post("/api/management/products/import/", {"file": bad}, format="multipart").status_code == 400
    txt = io.BytesIO(b"x")
    txt.name = "p.txt"
    assert c.post("/api/management/products/import/", {"file": txt}, format="multipart").status_code == 400
    assert c.post("/api/management/products/import/", {}, format="multipart").status_code == 400
    assert api(w["au"]).post("/api/management/products/import/", {}, format="multipart").status_code == 403


# ================================ Transfers ================================

def payload(w, **kw):
    p = {"mode": "owner_state", "owner_id": w["a"].id, "state": "MH", "to_salesman_id": w["b"].id}
    p.update(kw)
    return p


def test_transfer_preview_counts_only_matching_dealers(w):
    d1 = dealer("D1", w["a"]); d2 = dealer("D2", w["a"]); dealer("Other state", w["a"], state="KA")
    dealer("Not mine", w["c"]); dealer("Archived", w["a"], is_archived=True)
    Followup.objects.create(dealer=d1, salesman=w["a"], due_date=timezone.localdate(), status="pending")
    Followup.objects.create(dealer=d2, salesman=w["a"], due_date=timezone.localdate(), status="completed")
    r = api(w["admin"]).post("/api/management/transfers/preview/", payload(w), format="json")
    assert r.status_code == 200
    assert r.data["dealers"] == 2 and r.data["open_followups"] == 1 and len(r.data["sample"]) == 2
    assert Dealer.objects.filter(pk__in=DealerOwnershipHistory.objects.filter(salesman=w["b"]).values("dealer_id")).count() == 0


def test_owner_state_transfer_end_to_end(w):
    d1 = dealer("D1", w["a"]); d2 = dealer("D2", w["a"]); keep_ka = dealer("KA", w["a"], state="KA")
    keep_c = dealer("C's", w["c"])
    fu = Followup.objects.create(dealer=d1, salesman=w["a"], due_date=timezone.localdate(), status="pending")
    done = Followup.objects.create(dealer=d1, salesman=w["a"], due_date=timezone.localdate(), status="completed")
    kafu = Followup.objects.create(dealer=keep_ka, salesman=w["a"], due_date=timezone.localdate(), status="pending")
    r = api(w["admin"]).post("/api/management/transfers/", payload(w, reason="territory_change"), format="json")
    assert r.status_code == 201 and r.data == {"transferred": 2, "followups_reassigned": 1, "territories_moved": 0}
    assert owner_of(d1) == w["b"] and owner_of(d2) == w["b"]
    assert owner_of(keep_ka) == w["a"] and owner_of(keep_c) == w["c"]
    old = DealerOwnershipHistory.objects.get(dealer=d1, salesman=w["a"])
    assert old.ended_at is not None and DealerOwnershipHistory.objects.filter(dealer=d1).count() == 2  # history kept
    assert DealerOwnershipHistory.objects.get(dealer=d1, ended_at=None).reason == "Territory change"
    for f, sm in ((fu, w["b"]), (done, w["a"]), (kafu, w["a"])):
        f.refresh_from_db()
        assert f.salesman == sm  # completed history stays with who did it


def test_transfer_without_reassigning_followups(w):
    d1 = dealer("D1", w["a"])
    fu = Followup.objects.create(dealer=d1, salesman=w["a"], due_date=timezone.localdate(), status="pending")
    r = api(w["admin"]).post("/api/management/transfers/", payload(w, reassign_followups=False), format="json")
    assert r.status_code == 201 and r.data["followups_reassigned"] == 0
    fu.refresh_from_db()
    assert fu.salesman == w["a"]


def test_owner_city_and_specific_dealer_modes(w):
    p1 = dealer("P1", w["a"], city="Pune"); n1 = dealer("N1", w["a"], city="Nagpur")
    c = api(w["admin"])
    r = c.post("/api/management/transfers/", payload(w, mode="owner_city", state="", city="pune"), format="json")
    assert r.data["transferred"] == 1 and owner_of(p1) == w["b"] and owner_of(n1) == w["a"]
    r = c.post("/api/management/transfers/", {"mode": "dealer", "dealer_id": n1.id, "to_salesman_id": w["c"].id}, format="json")
    assert r.status_code == 201 and owner_of(n1) == w["c"]


def test_specific_unowned_dealer_can_be_assigned(w):
    d = dealer("Loose")
    r = api(w["admin"]).post("/api/management/transfers/", {"mode": "dealer", "dealer_id": d.id, "to_salesman_id": w["b"].id}, format="json")
    assert r.status_code == 201 and owner_of(d) == w["b"]


def test_transfer_validation(w):
    c = api(w["admin"])
    dealer("D1", w["a"])
    assert c.post("/api/management/transfers/", payload(w, to_salesman_id=w["a"].id), format="json").status_code == 400
    assert c.post("/api/management/transfers/", payload(w, to_salesman_id=9999), format="json").status_code == 400
    w["c"].is_active = False
    w["c"].save()
    assert c.post("/api/management/transfers/", payload(w, to_salesman_id=w["c"].id), format="json").status_code == 400
    assert c.post("/api/management/transfers/", payload(w, state=""), format="json").status_code == 400
    assert c.post("/api/management/transfers/", payload(w, mode="nope"), format="json").status_code == 400
    assert c.post("/api/management/transfers/", payload(w, reason="because"), format="json").status_code == 400
    assert c.post("/api/management/transfers/", {"mode": "dealer", "to_salesman_id": w["b"].id}, format="json").status_code == 400
    # Nothing to move.
    r = c.post("/api/management/transfers/", payload(w, state="TN"), format="json")
    assert r.status_code == 400


def test_transfer_is_all_or_nothing(w, monkeypatch):
    d1 = dealer("D1", w["a"]); d2 = dealer("D2", w["a"])
    fu = Followup.objects.create(dealer=d1, salesman=w["a"], due_date=timezone.localdate(), status="pending")
    from apps.management import scope_service

    real, calls = scope_service.transfer_ownership, {"n": 0}

    def flaky(*a, **k):
        calls["n"] += 1
        if calls["n"] == 2:
            raise RuntimeError("boom")
        return real(*a, **k)

    monkeypatch.setattr(scope_service, "transfer_ownership", flaky)
    c = APIClient(raise_request_exception=False)
    c.force_authenticate(w["admin"])
    assert c.post("/api/management/transfers/", payload(w), format="json").status_code == 500
    assert owner_of(d1) == w["a"] and owner_of(d2) == w["a"]
    fu.refresh_from_db()
    assert fu.salesman == w["a"]


def test_transfer_roles(w):
    dealer("D1", w["a"])
    assert api(w["mgr"]).post("/api/management/transfers/", payload(w), format="json").status_code == 403
    assert api(w["mgr"]).post("/api/management/transfers/preview/", payload(w), format="json").status_code == 403
    assert api(w["au"]).post("/api/management/transfers/", payload(w), format="json").status_code == 403
    assert APIClient().post("/api/management/transfers/", payload(w), format="json").status_code == 401
    o = api(w["mgr"]).get("/api/management/scope-options/")
    assert o.status_code == 200 and {s["name"] for s in o.data["salesmen"]} >= {"Alice", "Bob"} and "MH" in o.data["states"]
    assert api(w["au"]).get("/api/management/scope-options/").status_code == 403


def test_transfer_keeps_receiving_salesmans_dealers_noop(w):
    d1 = dealer("D1", w["a"])
    DealerAccessGrant.objects.create(salesman=w["b"], dealer=d1)
    api(w["admin"]).post("/api/management/transfers/", payload(w), format="json")
    # The redundant per-dealer grant is retired because the new owner never needs one.
    assert DealerAccessGrant.objects.get(salesman=w["b"], dealer=d1).revoked_at is not None


# ================================ Ownership cleanup ================================

def test_cleanup_groups_filters_and_roles(w):
    dealer("N1", None, state="MH", city="Nagpur"); dealer("N2", None, state="MH", city="Nagpur")
    dealer("Del", None, state="Delhi", city="Delhi")
    dealer("Owned", w["a"], state="MH", city="Nagpur"); dealer("Arch", None, is_archived=True, state="MH", city="Nagpur")
    r = api(w["mgr"]).get("/api/management/ownership-cleanup/")
    assert r.status_code == 200 and r.data["total"] == 3
    assert {(g["state"], g["city"], g["count"]) for g in r.data["groups"]} == {("MH", "Nagpur", 2), ("Delhi", "Delhi", 1)}
    assert api(w["mgr"]).get("/api/management/ownership-cleanup/?state=MH").data["total"] == 2
    assert api(w["mgr"]).get("/api/management/ownership-cleanup/?q=del").data["total"] == 1
    assert api(w["au"]).get("/api/management/ownership-cleanup/").status_code == 403


def test_cleanup_assign_group(w):
    n1 = dealer("N1", None, state="MH", city="Nagpur"); n2 = dealer("N2", None, state="MH", city="Nagpur")
    other = dealer("Del", None, state="Delhi", city="Delhi")
    body = {"salesman_id": w["b"].id, "state": "MH", "city": "Nagpur"}
    assert api(w["mgr"]).post("/api/management/ownership-cleanup/assign/", body, format="json").status_code == 403
    r = api(w["admin"]).post("/api/management/ownership-cleanup/assign/", body, format="json")
    assert r.status_code == 201 and r.data["assigned"] == 2
    assert owner_of(n1) == w["b"] and owner_of(n2) == w["b"] and owner_of(other) is None
    assert DealerOwnershipHistory.objects.get(dealer=n1).reason == "Ownership cleanup"
    # Re-running finds nothing left rather than reassigning owned dealers.
    assert api(w["admin"]).post("/api/management/ownership-cleanup/assign/", body, format="json").status_code == 400
    assert owner_of(n1) == w["b"]


def test_cleanup_assign_validation(w):
    dealer("N1", None)
    c = api(w["admin"])
    assert c.post("/api/management/ownership-cleanup/assign/", {"salesman_id": 999, "state": "MH", "city": "Pune"}, format="json").status_code == 400
    assert c.post("/api/management/ownership-cleanup/assign/", {"salesman_id": w["b"].id}, format="json").status_code == 400


# ================================ Access grants ================================

def grant_body(w, **kw):
    p = {"mode": "owner_state", "owner_id": w["a"].id, "state": "MH", "salesman_id": w["c"].id,
         "access_type": "shared"}
    p.update(kw)
    return p


def test_scope_grant_gives_access_without_changing_ownership(w):
    d1 = dealer("D1", w["a"]); ka = dealer("KA", w["a"], state="KA"); bobs = dealer("Bobs", w["b"])
    assert list(accessible_dealers(w["cu"])) == []
    r = api(w["admin"]).post("/api/management/access-grants/", grant_body(w), format="json")
    assert r.status_code == 201
    assert set(accessible_dealers(w["cu"])) == {d1}  # only owner+state scope
    assert owner_of(d1) == w["a"] and ka not in accessible_dealers(w["cu"]) and bobs not in accessible_dealers(w["cu"])
    # A dealer later transferred out of the owner's book leaves the scope automatically.
    DealerOwnershipHistory.objects.filter(dealer=d1, ended_at=None).update(ended_at=timezone.now())
    assert list(accessible_dealers(w["cu"])) == []


def test_owner_city_and_dealer_grants(w):
    p1 = dealer("P1", w["a"], city="Pune"); n1 = dealer("N1", w["a"], city="Nagpur")
    c = api(w["admin"])
    assert c.post("/api/management/access-grants/", grant_body(w, mode="owner_city", state="", city="Pune"), format="json").status_code == 201
    assert set(accessible_dealers(w["cu"])) == {p1}
    assert c.post("/api/management/access-grants/", {"mode": "dealer", "dealer_id": n1.id, "salesman_id": w["c"].id}, format="json").status_code == 201
    assert set(accessible_dealers(w["cu"])) == {p1, n1}


def test_temporary_coverage_needs_end_date_and_window_is_enforced(w):
    d1 = dealer("D1", w["a"])
    c = api(w["admin"])
    today = timezone.localdate()
    r = c.post("/api/management/access-grants/", grant_body(w, access_type="temporary"), format="json")
    assert r.status_code == 400 and "ends_on" in r.data
    assert c.post("/api/management/access-grants/", grant_body(w, ends_on=str(today - timedelta(days=1))), format="json").status_code == 400
    assert c.post("/api/management/access-grants/", grant_body(w, starts_on=str(today + timedelta(days=3)), ends_on=str(today + timedelta(days=1))), format="json").status_code == 400
    r = c.post("/api/management/access-grants/", grant_body(w, access_type="temporary", ends_on=str(today + timedelta(days=2))), format="json")
    assert r.status_code == 201 and list(accessible_dealers(w["cu"])) == [d1]
    # Time passes: expiry and not-yet-started both remove access without any cleanup job.
    DealerAccessGrant.objects.update(ends_on=today - timedelta(days=1))
    assert list(accessible_dealers(w["cu"])) == []
    DealerAccessGrant.objects.update(starts_on=today + timedelta(days=1), ends_on=today + timedelta(days=5))
    assert list(accessible_dealers(w["cu"])) == []
    DealerAccessGrant.objects.update(starts_on=today, ends_on=today)  # inclusive on both ends
    assert list(accessible_dealers(w["cu"])) == [d1]


def test_grant_validation_and_duplicates(w):
    d1 = dealer("D1", w["a"])
    c = api(w["admin"])
    assert c.post("/api/management/access-grants/", grant_body(w, salesman_id=w["a"].id), format="json").status_code == 400  # owner to self
    assert c.post("/api/management/access-grants/", grant_body(w, salesman_id=9999), format="json").status_code == 400
    assert c.post("/api/management/access-grants/", grant_body(w, state="TN"), format="json").status_code == 400  # no dealers
    assert c.post("/api/management/access-grants/", grant_body(w, access_type="forever"), format="json").status_code == 400
    assert c.post("/api/management/access-grants/", grant_body(w), format="json").status_code == 201
    assert c.post("/api/management/access-grants/", grant_body(w), format="json").status_code == 400  # same scope twice
    body = {"mode": "dealer", "dealer_id": d1.id, "salesman_id": w["a"].id}
    assert c.post("/api/management/access-grants/", body, format="json").status_code == 400  # owner
    body["salesman_id"] = w["b"].id
    assert c.post("/api/management/access-grants/", body, format="json").status_code == 201
    assert c.post("/api/management/access-grants/", body, format="json").status_code == 400


def test_expired_dealer_grant_does_not_block_a_new_one(w):
    d1 = dealer("D1", w["a"])
    DealerAccessGrant.objects.create(salesman=w["b"], dealer=d1, ends_on=timezone.localdate() - timedelta(days=2))
    body = {"mode": "dealer", "dealer_id": d1.id, "salesman_id": w["b"].id}
    assert api(w["admin"]).post("/api/management/access-grants/", body, format="json").status_code == 201
    assert list(accessible_dealers(w["bu"])) == [d1]


def test_grant_preview_and_roles(w):
    dealer("D1", w["a"]); dealer("D2", w["a"])
    r = api(w["admin"]).post("/api/management/access-grants/preview/", grant_body(w), format="json")
    assert r.status_code == 200 and r.data["dealers"] == 2 and not DealerAccessGrant.objects.exists()
    assert api(w["mgr"]).post("/api/management/access-grants/", grant_body(w), format="json").status_code == 403
    assert api(w["mgr"]).post("/api/management/access-grants/preview/", grant_body(w), format="json").status_code == 403
    assert api(w["au"]).get("/api/management/access-grants/").status_code == 403
    assert api(w["mgr"]).get("/api/management/access-grants/").status_code == 200


def test_list_status_filter_and_revoke(w):
    d1 = dealer("Ambica", w["a"]); d2 = dealer("D2", w["a"]); d3 = dealer("D3", w["a"])
    today = timezone.localdate()
    live = DealerAccessGrant.objects.create(salesman=w["c"], dealer=d1, access_type="temporary", ends_on=today + timedelta(days=3))
    DealerAccessGrant.objects.create(salesman=w["c"], dealer=d2, ends_on=today - timedelta(days=1))
    DealerAccessGrant.objects.create(salesman=w["c"], dealer=d3, starts_on=today + timedelta(days=2))
    scope = DealerAccessGrant.objects.create(salesman=w["b"], owner=w["a"], state="MH")
    c = api(w["admin"])
    r = c.get("/api/management/access-grants/")
    assert r.data["count"] == 4
    by_status = {x["scope"]: x["status"] for x in r.data["results"]}
    assert by_status == {"Ambica": "active", "D2": "expired", "D3": "scheduled", "MH": "active"}
    row = next(x for x in r.data["results"] if x["scope"] == "MH")
    assert row["source_owner"] == "Alice" and row["type"] == "Shared Access" and row["grantee"] == "Bob"
    assert next(x for x in r.data["results"] if x["scope"] == "Ambica")["type"] == "Temporary Coverage"
    assert c.get("/api/management/access-grants/?status=active").data["count"] == 2
    assert c.get("/api/management/access-grants/?status=expired").data["count"] == 1
    assert c.get("/api/management/access-grants/?status=scheduled").data["count"] == 1

    assert api(w["mgr"]).post(f"/api/management/access-grants/{live.id}/revoke/").status_code == 403
    assert c.post(f"/api/management/access-grants/{live.id}/revoke/").status_code == 200
    assert c.post(f"/api/management/access-grants/{live.id}/revoke/").status_code == 404  # already revoked
    assert c.post(f"/api/management/access-grants/{scope.id}/revoke/").status_code == 200
    assert c.get("/api/management/access-grants/?status=revoked").data["count"] == 2
    assert list(accessible_dealers(w["bu"])) == []


def test_dealer_detail_grant_list_hides_expired_grants(w):
    d1 = dealer("D1", w["a"])
    DealerAccessGrant.objects.create(salesman=w["b"], dealer=d1, ends_on=timezone.localdate() - timedelta(days=1))
    DealerAccessGrant.objects.create(salesman=w["c"], dealer=d1)
    r = api(w["admin"]).get(f"/api/dealers/{d1.id}/")
    assert [g["salesman"] for g in r.data["grants"]] == ["Carl"]
