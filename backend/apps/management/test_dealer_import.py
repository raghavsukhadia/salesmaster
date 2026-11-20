import io

import pytest
from openpyxl import Workbook
from rest_framework.test import APIClient

from apps.accounts.models import Role, Salesman, User
from apps.dealers.access import accessible_dealers
from apps.dealers.models import Dealer, DealerOwnershipHistory

pytestmark = pytest.mark.django_db
URL = "/api/management/dealers/import/"


def mk(username, role=Role.SALESMAN, first="", last="", active=True):
    u = User.objects.create_user(username, f"{username}@x.com", "pw-12345-abc", role=role, first_name=first, last_name=last)
    if role != Role.SALESMAN:
        return u, None
    return u, Salesman.objects.create(user=u, is_active=active, phone_number=f"80000{u.id:05d}")  # phone numbers are unique


def client(user):
    c = APIClient()
    c.force_authenticate(user)
    return c


def csv_file(text, name="dealers.csv"):
    f = io.BytesIO(text.encode())
    f.name = name
    return f


def owner(d):
    o = DealerOwnershipHistory.objects.filter(dealer=d, ended_at=None).first()
    return o.salesman if o else None


@pytest.fixture
def w():
    admin, _ = mk("admin", Role.ADMIN)
    mgr, _ = mk("mgr", Role.MANAGER)
    du, demo = mk("demo", first="Demo", last="Test")
    ru, ravi = mk("ravi", first="Ravi", last="Kumar")
    return {"admin": admin, "mgr": mgr, "demo": demo, "demo_user": du, "ravi": ravi}


def test_import_assigns_everything_to_the_chosen_salesman_and_it_shows_in_their_dealers(w):
    f = csv_file("Name,Phone,City,State,Pincode,Address\nXYZ Motors,+91 98765 43210,Pune,Maharashtra,411001,MG Road\nABC Tyres,,Nagpur,Maharashtra,,\n")
    r = client(w["admin"]).post(URL, {"file": f, "salesman_id": w["demo"].id}, format="multipart")
    assert r.status_code == 200, r.data
    assert r.data["created"] == 2 and r.data["assigned"] == 2 and r.data["unassigned"] == 0
    xyz = Dealer.objects.get(name="XYZ Motors")
    assert xyz.phone == "9876543210" and xyz.city == "Pune" and xyz.pincode == "411001"
    assert owner(xyz) == w["demo"] and xyz.primary_salesman == w["demo"]
    assert DealerOwnershipHistory.objects.get(dealer=xyz).changed_by == w["admin"]
    assert set(accessible_dealers(w["demo_user"]).values_list("name", flat=True)) == {"XYZ Motors", "ABC Tyres"}


def test_a_salesman_column_wins_over_the_default_and_matches_username_email_or_full_name(w):
    f = csv_file("Dealer Name,Mobile No,Salesman\nOne,9000000001,ravi\nTwo,9000000002,demo@x.com\nThree,9000000003,Ravi Kumar\nFour,9000000004,\n")
    r = client(w["admin"]).post(URL, {"file": f, "salesman_id": w["demo"].id}, format="multipart")
    assert r.data["created"] == 4, r.data
    assert owner(Dealer.objects.get(name="One")) == w["ravi"]
    assert owner(Dealer.objects.get(name="Two")) == w["demo"]
    assert owner(Dealer.objects.get(name="Three")) == w["ravi"]
    assert owner(Dealer.objects.get(name="Four")) == w["demo"]  # blank cell -> the default


def test_without_a_salesman_dealers_are_added_unassigned(w):
    r = client(w["admin"]).post(URL, {"file": csv_file("Name\nLone Dealer\n")}, format="multipart")
    assert r.data["created"] == 1 and r.data["unassigned"] == 1
    assert owner(Dealer.objects.get(name="Lone Dealer")) is None


def test_existing_and_repeated_phones_are_skipped_and_bad_rows_reported(w):
    Dealer.objects.create(name="Already Here", phone="9876543210")
    f = csv_file(
        "Name,Phone,Salesman\n"
        "Dup Of Existing,98765-43210,\n"   # same number as an existing dealer
        "First,9111111111,\n"
        "Repeat In File,9111111111,\n"     # same number twice in the sheet
        ",9222222222,\n"                   # no name
        "Short Phone,12345,\n"             # not 10 digits
        "Ghost Owner,9333333333,nobody\n"  # unknown salesman
        ",,\n"                             # blank row: ignored
    )
    r = client(w["admin"]).post(URL, {"file": f}, format="multipart")
    assert r.data["created"] == 1, r.data
    assert r.data["skipped_count"] == 2 and r.data["skipped_duplicates"] == ["Dup Of Existing", "Repeat In File"]
    assert [x["row"] for x in r.data["invalid_rows"]] == [5, 6, 7]
    assert "not found" in r.data["invalid_rows"][2]["reason"]
    assert Dealer.objects.get(phone="9876543210").name == "Already Here"  # never overwritten


def test_xlsx_with_numeric_phone_cells(w):
    wb = Workbook()
    ws = wb.active
    ws.append(["Name", "Phone", "GSTIN"])
    ws.append(["Excel Dealer", 9876500000, "27abcde1234f1z5"])
    ws.append(["Float Phone", 9876500001.0, None])
    buf = io.BytesIO()
    wb.save(buf)
    buf.seek(0)
    buf.name = "d.xlsx"
    r = client(w["admin"]).post(URL, {"file": buf}, format="multipart")
    assert r.data["created"] == 2, r.data
    d = Dealer.objects.get(name="Excel Dealer")
    assert d.phone == "9876500000" and d.gst_number == "27ABCDE1234F1Z5"
    assert Dealer.objects.get(name="Float Phone").phone == "9876500001"


def test_only_admins_can_import_and_the_file_must_be_usable(w):
    assert client(w["mgr"]).post(URL, {"file": csv_file("Name\nX\n")}, format="multipart").status_code == 403
    assert client(w["demo_user"]).post(URL, {"file": csv_file("Name\nX\n")}, format="multipart").status_code == 403
    c = client(w["admin"])
    assert c.post(URL, {}, format="multipart").status_code == 400
    assert c.post(URL, {"file": csv_file("Phone\n9876543210\n")}, format="multipart").status_code == 400  # no Name column
    assert c.post(URL, {"file": csv_file("x", "d.txt")}, format="multipart").status_code == 400
    _, gone = mk("gone", active=False)
    assert c.post(URL, {"file": csv_file("Name\nX\n"), "salesman_id": gone.id}, format="multipart").status_code == 400
    assert not Dealer.objects.exists()


def test_null_placeholders_in_the_file_are_stored_as_blank(w):
    f = csv_file("Name,Phone,City,State,Pincode\nK K Auto,9000000011,Nanded,null\nZyan Car,9000000012,NULL,N/A,nan\n")
    r = client(w["admin"]).post(URL, {"file": f}, format="multipart")
    assert r.data["created"] == 2, r.data
    kk = Dealer.objects.get(name="K K Auto")
    assert kk.city == "Nanded" and kk.state == ""
    zy = Dealer.objects.get(name="Zyan Car")
    assert zy.city == "" and zy.state == "" and zy.pincode == ""


def test_dealer_list_can_hide_the_ones_a_salesman_already_owns(w):
    f = csv_file("Name,Phone,Salesman\nMine,9000000021,demo\nTheirs,9000000022,ravi\nNobody's,9000000023,\n")
    client(w["admin"]).post(URL, {"file": f}, format="multipart")
    r = client(w["admin"]).get("/api/management/dealers/", {"not_owner": w["demo"].id})
    assert {row["name"] for row in r.data["results"]} == {"Theirs", "Nobody's"}
    assert r.data["count"] == 2
