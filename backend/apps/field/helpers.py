"""Shared builders for the field tests."""
import uuid
from datetime import timedelta

from django.utils import timezone
from rest_framework.test import APIClient

from apps.accounts.models import Role, Salesman, User
from apps.dealers.models import Dealer, DealerOwnershipHistory
from apps.field import services
from apps.field.models import WorkSession

PUNE = (18.5204, 73.8567)
# ~0.009 degrees of latitude is ~1 km; these offsets keep the arithmetic in the tests obvious.
KM = 1 / 111.195


def make_user(name, role=Role.SALESMAN):
    return User.objects.create_user(name, role=role)


def make_salesman(name="sam", phone=None, active=True):
    user = make_user(name, Role.SALESMAN)
    n = Salesman.objects.count() + 1
    return Salesman.objects.create(user=user, phone_number=phone or f"90000{n:05d}", is_active=active)


def api(user):
    c = APIClient()
    c.force_authenticate(user)
    return c


def make_dealer(name, lat=None, lng=None, owner=None, **kw):
    d = Dealer.objects.create(name=name, latitude=lat, longitude=lng, **kw)
    if owner is not None:
        DealerOwnershipHistory.objects.create(dealer=d, salesman=owner)
    return d


def go_on_duty(salesman, started_ago=timedelta(hours=1), now=None):
    """An open session that began ``started_ago`` before ``now`` (default: the real now)."""
    now = now or timezone.now()
    return WorkSession.objects.create(
        salesman=salesman, started_at=now - started_ago, consent_version="test", last_contact_at=now
    )


def set_fix(session, lat, lng, age_s=10, accuracy=15.0, now=None):
    now = now or timezone.now()
    session.last_lat, session.last_lng = round(lat, 6), round(lng, 6)
    session.last_accuracy_m = accuracy
    session.last_fix_at = now - timedelta(seconds=age_s)
    session.save(update_fields=["last_lat", "last_lng", "last_accuracy_m", "last_fix_at"])
    return session


def point(lat=PUNE[0], lng=PUNE[1], at=None, accuracy=10.0, pid=None):
    return {
        "client_point_id": pid or uuid.uuid4(),
        "latitude": lat, "longitude": lng, "accuracy_m": accuracy,
        "captured_at": at or timezone.now(),
    }


def payload_point(**kw):
    """Same as point(), shaped for a JSON request body."""
    p = point(**kw)
    return {**p, "client_point_id": str(p["client_point_id"]), "captured_at": p["captured_at"].isoformat()}


__all__ = ["services"]
