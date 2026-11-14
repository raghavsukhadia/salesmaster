"""Role matrix for every field endpoint. Each row: (method, url, who may call it)."""
import pytest
from rest_framework.test import APIClient

from apps.accounts.models import Role
from apps.field.helpers import PUNE, api, make_dealer, make_salesman, make_user

pytestmark = pytest.mark.django_db

SALESMAN, MANAGER, ADMIN = Role.SALESMAN, Role.MANAGER, Role.ADMIN
Q = f"?latitude={PUNE[0]}&longitude={PUNE[1]}&radius_km=5"

# (method, path with {sid}/{did} placeholders, roles allowed)
MATRIX = [
    ("get", "/api/field/session/", {SALESMAN}),
    ("post", "/api/field/session/start/", {SALESMAN}),
    ("post", "/api/field/session/end/", {SALESMAN}),
    ("post", "/api/field/locations/", {SALESMAN}),
    ("get", "/api/field/nearby-dealers/" + Q, {SALESMAN}),
    ("get", "/api/management/field/live/", {MANAGER, ADMIN}),
    ("get", "/api/management/field/salesmen/{sid}/track/", {MANAGER, ADMIN}),
    ("post", "/api/management/field/salesmen/{sid}/end-session/", {ADMIN}),
    ("get", "/api/management/field/nearby-dealers/" + Q, {MANAGER, ADMIN}),
    ("get", "/api/management/field/dealers/{did}/nearest-salesmen/", {MANAGER, ADMIN}),
    ("get", "/api/management/field/dealer-locations/", {MANAGER, ADMIN}),
    ("get", "/api/management/field/config/", {MANAGER, ADMIN}),
    ("put", "/api/management/field/config/", {ADMIN}),
    ("get", "/api/management/field/audit/", {ADMIN}),
    ("get", "/api/field/today/", {SALESMAN}),
    ("post", "/api/field/checkins/", {SALESMAN}),
    ("post", "/api/field/checkins/999999/check-out/", {SALESMAN}),
    ("post", "/api/field/stops/999999/skip/", {SALESMAN}),
    ("get", "/api/management/field/beats/", {MANAGER, ADMIN}),
    ("put", "/api/management/field/beats/", {MANAGER, ADMIN}),
    ("delete", "/api/management/field/beats/", {MANAGER, ADMIN}),
    ("get", "/api/management/field/beats/dealer-options/", {MANAGER, ADMIN}),
    ("get", "/api/management/field/checkins/", {MANAGER, ADMIN}),
    ("get", "/api/management/dealers/{did}/location/", {MANAGER, ADMIN}),
    ("put", "/api/management/dealers/{did}/location/", {MANAGER, ADMIN}),
    ("post", "/api/management/dealers/{did}/location/verify/", {MANAGER, ADMIN}),
]


@pytest.fixture
def ids():
    sam = make_salesman("sam")
    return {"sid": sam.id, "did": make_dealer("D", *PUNE).id, "sam_user": sam.user}


def who(role, ids):
    return ids["sam_user"] if role == SALESMAN else make_user(f"u-{role}", role)


@pytest.mark.parametrize("method,path,allowed", MATRIX, ids=[f"{m}:{p.split('?')[0]}" for m, p, _ in MATRIX])
def test_role_matrix(ids, method, path, allowed):
    url = path.format(**ids)
    anon = getattr(APIClient(), method)(url, {}, format="json")
    assert anon.status_code == 401, "anonymous callers must be turned away"
    for role in (SALESMAN, MANAGER, ADMIN):
        resp = getattr(api(who(role, ids)), method)(url, {}, format="json")
        if role in allowed:
            assert resp.status_code != 403, f"{role} should be allowed on {method} {url}"
        else:
            assert resp.status_code == 403, f"{role} must be refused on {method} {url}, got {resp.status_code}"


def test_a_user_without_a_salesman_profile_cannot_go_on_duty():
    ghost = make_user("ghost", Role.SALESMAN)  # role says salesman, but no Salesman row
    assert api(ghost).get("/api/field/session/").status_code == 403
