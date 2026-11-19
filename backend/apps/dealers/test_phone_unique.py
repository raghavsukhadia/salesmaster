import threading
import uuid

import pytest
from django.db import IntegrityError, connection, connections, transaction
from rest_framework.exceptions import ValidationError
from rest_framework.test import APIClient

from apps.accounts.models import Role, Salesman, User
from apps.dealers.models import Dealer, DealerContact, DealerOwnershipHistory
from apps.dealers.phone import normalize_phone
from apps.visits import services
from apps.visits.exceptions import DealerNotAvailable, DuplicateDealer
from apps.visits.models import Visit

URL = "/api/visits/record/"


def make_salesman(name, phone):
    user = User.objects.create_user(name, f"{name}@x.com", "pw-12345-abc", role=Role.SALESMAN)
    return user, Salesman.objects.create(user=user, phone_number=phone)


def client_for(user):
    c = APIClient()
    c.force_authenticate(user)
    return c


def payload(**dealer):
    d = {"name": "Sharma Auto", "phone": "98765 43210", "city": "Pune", "state": "MH", "latitude": "18.5204", "longitude": "73.8567"}
    d.update(dealer)
    return {"client_request_id": str(uuid.uuid4()), "new_dealer": d}


# ---- normalisation ----------------------------------------------------------------------------

@pytest.mark.parametrize("raw", ["+91 98765-43210", "09876543210", "(98765) 43210", "919876543210", " 9876543210 "])
def test_normalize_phone_variants_agree(raw):
    assert normalize_phone(raw) == "9876543210"


@pytest.mark.django_db
def test_model_save_normalises_phone_and_whatsapp():
    d = Dealer.objects.create(name="A", phone="+91 98765 43210", whatsapp="098765-43211")
    d.refresh_from_db()
    assert (d.phone, d.whatsapp) == ("9876543210", "9876543211")


# ---- constraint --------------------------------------------------------------------------------

@pytest.mark.django_db
def test_db_rejects_same_normalised_phone():
    Dealer.objects.create(name="A", phone="9876543210")
    with pytest.raises(IntegrityError), transaction.atomic():
        Dealer.objects.create(name="B", phone="+91-98765 43210")


@pytest.mark.django_db
def test_blank_phones_may_repeat():
    Dealer.objects.create(name="A")
    Dealer.objects.create(name="B", phone="")
    Dealer.objects.create(name="C", phone="abc")  # normalises to blank
    assert Dealer.objects.filter(phone="").count() == 3


@pytest.mark.django_db
def test_constraint_enforced_even_if_application_checks_are_bypassed():
    Dealer.objects.create(name="A", phone="9876543210")
    b = Dealer.objects.create(name="B", phone="9111111111")
    with pytest.raises(IntegrityError), transaction.atomic():
        Dealer.objects.filter(pk=b.pk).update(phone="9876543210")


# ---- API behaviour -----------------------------------------------------------------------------

@pytest.mark.django_db
def test_record_visit_duplicate_phone_variant_is_rejected_for_owner():
    user, sm = make_salesman("alice", "9000000001")
    d = Dealer.objects.create(name="Existing", phone="9876543210", city="Pune")
    DealerOwnershipHistory.objects.create(dealer=d, salesman=sm)
    r = client_for(user).post(URL, payload(name="Other Name", city="Delhi", phone="+91 98765-43210"), format="json")
    assert r.status_code == 409 and r.data["code"] == "duplicate_dealer" and r.data["dealer"]["id"] == d.id
    assert Dealer.objects.count() == 1 and Visit.objects.count() == 0


@pytest.mark.django_db
def test_inaccessible_duplicate_leaks_nothing():
    user, _ = make_salesman("alice", "9000000001")
    _, bob = make_salesman("bob", "9000000002")
    d = Dealer.objects.create(name="Secret Name", phone="9876543210", city="Goa")
    DealerOwnershipHistory.objects.create(dealer=d, salesman=bob)
    r = client_for(user).post(URL, payload(name="Zed", city="Delhi"), format="json")
    assert r.status_code == 409
    body = str(r.data)
    assert "This dealer is not available to you" in body and "Secret" not in body and "bob" not in body


@pytest.mark.django_db
def test_stale_duplicate_check_falls_back_to_clear_error_and_rolls_back(monkeypatch):
    """The app-level check misses (simulated race); the DB constraint must still stop the insert."""
    user, sm = make_salesman("alice", "9000000001")
    d = Dealer.objects.create(name="Winner", phone="9876543210", city="Pune")
    DealerOwnershipHistory.objects.create(dealer=d, salesman=sm)

    real = services.find_duplicate
    calls = {"n": 0}

    def stale(**kw):
        calls["n"] += 1
        return None if calls["n"] == 1 else real(**kw)

    monkeypatch.setattr(services, "find_duplicate", stale)
    r = client_for(user).post(URL, payload(name="Loser", city="Delhi"), format="json")
    assert r.status_code == 409 and r.data["dealer"]["id"] == d.id
    assert Dealer.objects.count() == 1 and Visit.objects.count() == 0
    assert DealerOwnershipHistory.objects.count() == 1  # nothing half-written


@pytest.mark.django_db
def test_stale_check_for_inaccessible_winner_stays_hidden(monkeypatch):
    user, _ = make_salesman("alice", "9000000001")
    _, bob = make_salesman("bob", "9000000002")
    d = Dealer.objects.create(name="Secret Name", phone="9876543210")
    DealerOwnershipHistory.objects.create(dealer=d, salesman=bob)
    real = services.find_duplicate
    n = {"c": 0}
    monkeypatch.setattr(services, "find_duplicate", lambda **kw: (n.update(c=n["c"] + 1) or None) if n["c"] == 0 else real(**kw))
    r = client_for(user).post(URL, payload(name="Zed", city="Delhi"), format="json")
    assert r.status_code == 409 and "Secret" not in str(r.data)


@pytest.mark.django_db
def test_same_request_id_still_idempotent_with_constraint():
    user, _ = make_salesman("alice", "9000000001")
    body = payload()
    c = client_for(user)
    first = c.post(URL, body, format="json")
    second = c.post(URL, body, format="json")
    assert first.status_code == 201 and second.status_code == 200
    assert second.data["visit_id"] == first.data["visit_id"] and Dealer.objects.count() == 1


@pytest.mark.django_db
def test_existing_dealer_visit_unaffected():
    user, sm = make_salesman("alice", "9000000001")
    d = Dealer.objects.create(name="Mine", phone="9876543210")
    DealerOwnershipHistory.objects.create(dealer=d, salesman=sm)
    r = client_for(user).post(URL, {"dealer_id": d.id}, format="json")
    assert r.status_code == 201


@pytest.mark.django_db
def test_management_edit_to_taken_phone_is_400_with_field_error():
    admin = User.objects.create_user("adm", "a@x.com", "pw-12345-abc", role=Role.ADMIN)
    Dealer.objects.create(name="Other", phone="9111111111")
    mine = Dealer.objects.create(name="Mine", phone="9222222222")
    r = client_for(admin).patch(f"/api/dealers/{mine.id}/", {"phone": "+91 91111 11111"}, format="json")
    assert r.status_code == 400 and "phone" in r.data
    mine.refresh_from_db()
    assert mine.phone == "9222222222"


@pytest.mark.django_db
def test_edit_race_on_phone_returns_400_not_500(monkeypatch):
    admin = User.objects.create_user("adm", "a@x.com", "pw-12345-abc", role=Role.ADMIN)
    mine = Dealer.objects.create(name="Mine", phone="9222222222")
    real_save = Dealer.save

    def save_after_rival_commit(self, *a, **k):
        # Another request commits the same phone between the pre-check and our save.
        if self.pk == mine.pk and not Dealer.objects.filter(phone="9333333333").exists():
            Dealer.objects.create(name="Rival", phone="9333333333")
        return real_save(self, *a, **k)

    monkeypatch.setattr(Dealer, "save", save_after_rival_commit)
    r = client_for(admin).patch(f"/api/dealers/{mine.id}/", {"phone": "9333333333"}, format="json")
    assert r.status_code == 400 and r.data["phone"]
    assert Dealer.objects.get(pk=mine.pk).phone == "9222222222"


# ---- concurrency -------------------------------------------------------------------------------

@pytest.mark.django_db(transaction=True)
def test_simultaneous_dealer_creation_yields_exactly_one_dealer():
    users = [make_salesman(f"s{i}", f"90000000{i:02d}") for i in range(6)]
    barrier = threading.Barrier(len(users))
    results, errors = [], []

    def worker(user):
        try:
            barrier.wait()
            # Same number written differently, different names/cities so only the phone can collide.
            phone = ["9876543210", "+91 98765 43210", "09876543210"][len(results) % 3]
            visit, created = services.record_visit(
                user,
                {"client_request_id": str(uuid.uuid4()),
                 "new_dealer": {"name": f"Shop {user.username}", "phone": phone, "city": user.username, "latitude": "18.5204", "longitude": "73.8567"}},
            )
            results.append(("ok", visit.dealer_id))
        except (DuplicateDealer, DealerNotAvailable, ValidationError) as e:
            results.append(("rejected", type(e).__name__))
        except Exception as e:  # noqa: BLE001 - surfaced by the assertion below
            errors.append(repr(e))
        finally:
            connections.close_all()

    threads = [threading.Thread(target=worker, args=(u,)) for u, _ in users]
    for t in threads:
        t.start()
    for t in threads:
        t.join()

    assert not errors, errors
    assert len(results) == len(users)
    assert sum(1 for kind, _ in results if kind == "ok") == 1
    assert Dealer.objects.filter(phone="9876543210").count() == 1
    dealer = Dealer.objects.get(phone="9876543210")
    assert DealerOwnershipHistory.objects.filter(dealer=dealer, ended_at=None).count() == 1
    assert Visit.objects.count() == 1  # losers wrote nothing


@pytest.mark.django_db(transaction=True)
def test_simultaneous_identical_submits_dedupe_by_request_id():
    user, _ = make_salesman("alice", "9000000001")
    body = payload()
    n = 5
    barrier = threading.Barrier(n)
    out, errors = [], []

    def worker():
        try:
            barrier.wait()
            visit, created = services.record_visit(user, body)
            out.append((visit.id, created))
        except Exception as e:  # noqa: BLE001
            errors.append(repr(e))
        finally:
            connections.close_all()

    ts = [threading.Thread(target=worker) for _ in range(n)]
    for t in ts:
        t.start()
    for t in ts:
        t.join()
    assert not errors, errors
    assert len({v for v, _ in out}) == 1 and sum(1 for _, c in out if c) == 1
    assert Dealer.objects.count() == 1 and Visit.objects.count() == 1


# ---- migration data fix ------------------------------------------------------------------------

@pytest.mark.django_db(transaction=True)
def test_migration_keeps_oldest_and_preserves_other_numbers_as_contacts():
    from django.db.migrations.executor import MigrationExecutor

    def migrate(target):
        ex = MigrationExecutor(connection)
        ex.migrate(target)
        return ex.loader.project_state(target).apps

    before = [("dealers", "0003_dealer_detail")]
    after = [("dealers", "0004_dedupe_dealer_phones")]
    latest = [(a, n) for (a, n) in MigrationExecutor(connection).loader.graph.leaf_nodes() if a == "dealers"]
    try:
        old = migrate(before)
        D, C = old.get_model("dealers", "Dealer"), old.get_model("dealers", "DealerContact")
        keep = D.objects.create(name="Oldest", phone="+91 98765 43210", whatsapp="98765 43211")
        dup1 = D.objects.create(name="Dup1", phone="9876543210")
        dup2 = D.objects.create(name="Dup2", phone="09876543210")
        uniq = D.objects.create(name="Unique", phone="91111-11111")
        blank = D.objects.create(name="Blank")

        migrate(after)
        new = MigrationExecutor(connection).loader.project_state(after).apps
        D, C = new.get_model("dealers", "Dealer"), new.get_model("dealers", "DealerContact")
        assert D.objects.get(pk=keep.pk).phone == "9876543210"
        assert D.objects.get(pk=keep.pk).whatsapp == "9876543211"
        assert D.objects.get(pk=uniq.pk).phone == "9111111111"
        assert D.objects.get(pk=blank.pk).phone == ""
        for dup in (dup1, dup2):
            assert D.objects.get(pk=dup.pk).phone == ""  # cleared, but the dealer survives
            assert C.objects.get(dealer_id=dup.pk).phone == "9876543210"  # number preserved
        assert D.objects.count() == 5
    finally:
        migrate(latest)
    # And the constraint exists again at the latest state.
    Dealer.objects.create(name="X", phone="9555555555")
    with pytest.raises(IntegrityError), transaction.atomic():
        Dealer.objects.create(name="Y", phone="9555555555")
