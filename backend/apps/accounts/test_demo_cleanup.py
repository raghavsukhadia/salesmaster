import io
import sqlite3

import pytest
from django.core.management import call_command
from django.utils import timezone

from apps.accounts.models import Salesman, User
from apps.dealers.models import Dealer, DealerOwnershipHistory
from apps.visits.models import Visit, VisitOrderItem


@pytest.mark.django_db(transaction=True)
def test_cleanup_backs_up_protected_history_and_preserves_the_two_logins(tmp_path):
    admin = User.objects.create_user("admin", password="admin-secret", role="admin")
    demo = User.objects.create_user("demo@sunkool.in", password="demo-secret", role="salesman")
    demo_profile = Salesman.objects.create(user=demo, phone_number="9000000001")
    extra = User.objects.create_user("temporary", role="salesman")
    extra_profile = Salesman.objects.create(user=extra, phone_number="9000000002")
    dealer = Dealer.objects.create(name="Sample dealer", primary_salesman=extra_profile)
    DealerOwnershipHistory.objects.create(dealer=dealer, salesman=extra_profile)
    visit = Visit.objects.create(dealer=dealer, salesman=extra_profile, visited_at=timezone.now())
    VisitOrderItem.objects.create(visit=visit, product_name="Sample item", quantity=1)
    credentials = dict(User.objects.filter(pk__in=[admin.pk, demo.pk]).values_list("pk", "password"))

    call_command("clean_local_demo_data", backup_dir=str(tmp_path), stdout=io.StringIO())
    assert User.objects.count() == 3 and VisitOrderItem.objects.count() == 1
    assert not list(tmp_path.glob("*.sqlite3"))

    call_command("clean_local_demo_data", apply=True, backup_dir=str(tmp_path), stdout=io.StringIO())
    assert set(User.objects.values_list("username", flat=True)) == {"admin", "demo@sunkool.in"}
    assert dict(User.objects.values_list("pk", "password")) == credentials
    assert list(Salesman.objects.values_list("pk", flat=True)) == [demo_profile.pk]
    assert not Dealer.objects.exists() and not Visit.objects.exists() and not VisitOrderItem.objects.exists()
    [backup] = list(tmp_path.glob("*.sqlite3"))
    with sqlite3.connect(str(backup)) as db:
        assert db.execute("SELECT COUNT(*) FROM accounts_user").fetchone()[0] == 3
        assert db.execute("SELECT COUNT(*) FROM visits_visitorderitem").fetchone()[0] == 1
