import pytest
from rest_framework.test import APIClient

from apps.accounts.models import User

URL = "/api/me/password/"
OLD, NEW = "old-pass-1234", "brand-new-pass-9876"


def sign_in(username, password):
    return APIClient().post("/api/auth/token/", {"username": username, "password": password}, format="json")


def bearer(access):
    c = APIClient()
    c.credentials(HTTP_AUTHORIZATION=f"Bearer {access}")
    return c


@pytest.fixture
def admin(db):
    return User.objects.create_user("boss", password=OLD, role="admin")


def change(user, current=OLD, new=NEW):
    c = APIClient()
    c.force_authenticate(user)
    return c.post(URL, {"current_password": current, "new_password": new}, format="json")


@pytest.mark.django_db
def test_changing_the_password_works_and_the_new_one_signs_in(admin):
    r = change(admin)
    assert r.status_code == 200
    assert sign_in("boss", OLD).status_code == 401
    assert sign_in("boss", NEW).status_code == 200


@pytest.mark.django_db
def test_every_role_can_change_their_own_password():
    for role in ("admin", "manager", "salesman"):
        u = User.objects.create_user(f"u-{role}", password=OLD, role=role)
        assert change(u).status_code == 200, role


@pytest.mark.django_db
def test_the_reply_keeps_this_session_alive_but_every_older_session_is_signed_out(admin):
    old = sign_in("boss", OLD).json()
    assert bearer(old["access"]).get("/api/me/").status_code == 200

    r = bearer(old["access"]).post(URL, {"current_password": OLD, "new_password": NEW}, format="json")
    assert r.status_code == 200
    fresh = r.json()

    assert bearer(old["access"]).get("/api/me/").status_code == 401  # the old access token is revoked
    # The old refresh token may still be exchanged, but what it returns carries the old password hash and opens nothing.
    again = APIClient().post("/api/auth/token/refresh/", {"refresh": old["refresh"]}, format="json")
    assert again.status_code == 401 or bearer(again.json()["access"]).get("/api/me/").status_code == 401
    assert bearer(fresh["access"]).get("/api/me/").status_code == 200  # the caller carries on without signing in again
    renewed = APIClient().post("/api/auth/token/refresh/", {"refresh": fresh["refresh"]}, format="json")
    assert renewed.status_code == 200 and bearer(renewed.json()["access"]).get("/api/me/").status_code == 200


@pytest.mark.django_db
def test_a_wrong_current_password_is_refused_and_nothing_changes(admin):
    r = change(admin, current="not-my-password")
    assert r.status_code == 400 and "current_password" in r.json() and "new_password" not in r.json()
    assert sign_in("boss", OLD).status_code == 200


@pytest.mark.django_db
@pytest.mark.parametrize("weak", ["short1", "12345678901", "password"])  # too short, all digits, too common
def test_a_weak_new_password_is_refused_with_the_reason(admin, weak):
    r = change(admin, new=weak)
    assert r.status_code == 400 and r.json()["new_password"], weak
    assert sign_in("boss", OLD).status_code == 200


@pytest.mark.django_db
def test_a_password_that_is_just_the_username_is_refused():
    u = User.objects.create_user("sharmaautoadmin", password=OLD, role="manager")
    r = change(u, new="sharmaautoadmin1")
    assert r.status_code == 400 and r.json()["new_password"]


@pytest.mark.django_db
def test_the_new_password_must_differ_from_the_current_one(admin):
    r = change(admin, new=OLD)
    assert r.status_code == 400 and "different" in r.json()["new_password"][0]


@pytest.mark.django_db
def test_both_fields_are_required(admin):
    c = APIClient()
    c.force_authenticate(admin)
    r = c.post(URL, {}, format="json")
    assert r.status_code == 400 and set(r.json()) == {"current_password", "new_password"}


@pytest.mark.django_db
def test_you_must_be_signed_in():
    r = APIClient().post(URL, {"current_password": OLD, "new_password": NEW}, format="json")
    assert r.status_code == 401


@pytest.mark.django_db
def test_guessing_the_current_password_is_rate_limited(admin):
    for _ in range(10):
        assert change(admin, current="wrong-guess-1").status_code == 400
    assert change(admin, current="wrong-guess-1").status_code == 429
    assert change(admin).status_code == 429  # even the right password waits out the window
