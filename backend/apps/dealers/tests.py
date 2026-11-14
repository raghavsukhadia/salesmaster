import pytest
from rest_framework.test import APIClient

from apps.accounts.models import Role, Salesman, SalesmanTerritory, User
from apps.dealers.access import accessible_dealers
from apps.dealers.models import Dealer, DealerAccessGrant, DealerOwnershipHistory

pytestmark = pytest.mark.django_db


def make_salesman(name, phone):
    user = User.objects.create_user(name, password="pw-12345-x", role=Role.SALESMAN)
    return user, Salesman.objects.create(user=user, phone_number=phone)


def names(user):
    return set(accessible_dealers(user).values_list("name", flat=True))


def test_owner_sees_only_owned_dealers():
    u1, s1 = make_salesman("a", "1")
    _, s2 = make_salesman("b", "2")
    d1 = Dealer.objects.create(name="D1")
    d2 = Dealer.objects.create(name="D2")
    DealerOwnershipHistory.objects.create(dealer=d1, salesman=s1)
    DealerOwnershipHistory.objects.create(dealer=d2, salesman=s2)
    assert names(u1) == {"D1"}


def test_territory_does_not_grant_visibility():
    u1, s1 = make_salesman("a", "1")
    Dealer.objects.create(name="D1", state="MH", city="Pune")
    SalesmanTerritory.objects.create(salesman=s1, state="MH")
    assert names(u1) == set()


def test_ended_ownership_loses_access_and_grants_work():
    u1, s1 = make_salesman("a", "1")
    _, s2 = make_salesman("b", "2")
    d1 = Dealer.objects.create(name="D1", state="MH", city="Pune")
    d2 = Dealer.objects.create(name="D2", state="KA", city="Pune")
    own = DealerOwnershipHistory.objects.create(dealer=d1, salesman=s1)
    DealerOwnershipHistory.objects.create(dealer=d2, salesman=s2)
    from django.utils import timezone

    own.ended_at = timezone.now()
    own.save()
    assert names(u1) == set()
    DealerAccessGrant.objects.create(salesman=s1, state="KA", city="Pune")
    assert names(u1) == {"D2"}


def test_role_gating():
    admin = User.objects.create_user("adm", password="x", role=Role.ADMIN)
    mgr = User.objects.create_user("mgr", password="x", role=Role.MANAGER)
    sales, _ = make_salesman("s", "9")

    def status(user, url):
        c = APIClient()
        c.force_authenticate(user)
        return c.get(url).status_code

    assert status(sales, "/api/management/ping/") == 403
    assert status(mgr, "/api/management/ping/") == 200
    assert status(mgr, "/api/admin-area/ping/") == 403
    assert status(admin, "/api/admin-area/ping/") == 200
    assert status(admin, "/api/salesman/dealers/") == 403
    assert APIClient().get("/api/me/").status_code == 401
