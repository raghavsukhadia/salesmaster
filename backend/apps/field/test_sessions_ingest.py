import uuid
from datetime import timedelta

import pytest
from django.conf import settings
from django.utils import timezone
from rest_framework.exceptions import ValidationError

from apps.field import services
from apps.field.helpers import PUNE, api, go_on_duty, make_salesman, payload_point, point, set_fix
from apps.field.models import FieldAuditLog, LocationPing, WorkSession

pytestmark = pytest.mark.django_db
CONSENT = settings.FIELD_TRACKING["CONSENT_VERSION"]


@pytest.fixture
def sam():
    return make_salesman("sam")


def minutes(n):
    return timedelta(minutes=n)


def seconds(n):
    return timedelta(seconds=n)


# ---- duty sessions -------------------------------------------------------------------------------

def test_cannot_go_on_duty_without_accepting_the_current_notice(sam):
    for kwargs in ({"consent": False, "consent_version": CONSENT}, {"consent": True, "consent_version": "old"}):
        with pytest.raises(ValidationError):
            services.start_session(sam.user, sam, **kwargs)
    assert WorkSession.objects.count() == 0


def test_start_is_idempotent_and_one_open_session_per_salesman(sam):
    s1, created1 = services.start_session(sam.user, sam, consent=True, consent_version=CONSENT)
    s2, created2 = services.start_session(sam.user, sam, consent=True, consent_version=CONSENT)
    assert created1 and not created2 and s1.pk == s2.pk
    assert WorkSession.objects.filter(salesman=sam, ended_at__isnull=True).count() == 1
    assert FieldAuditLog.objects.filter(action="session_start").count() == 1


def test_end_session_and_end_when_not_on_duty(sam):
    services.start_session(sam.user, sam, consent=True, consent_version=CONSENT)
    assert services.end_session(sam.user, sam).ended_at is not None
    assert services.end_session(sam.user, sam) is None
    assert FieldAuditLog.objects.filter(action="session_end").count() == 1


def test_forgotten_session_is_closed_automatically():
    sam = make_salesman("forgetful")
    limit = timedelta(hours=settings.FIELD_TRACKING["MAX_SESSION_H"])
    go_on_duty(sam, started_ago=limit + minutes(5))
    assert services.get_active_session(sam) is None
    s = WorkSession.objects.get()
    assert s.end_reason == "auto_timeout" and s.ended_at == s.started_at + limit

    go_on_duty(sam, started_ago=limit + minutes(1))
    assert services.close_stale_sessions() == 1


# ---- tracking status: never call a stale fix live -------------------------------------------------

@pytest.mark.parametrize("age_s,expected", [(5, "live"), (118, "live"), (125, "stale"), (895, "stale"), (905, "lost"), (7200, "lost")])
def test_status_comes_from_the_age_of_the_fix(sam, age_s, expected):
    s = set_fix(go_on_duty(sam), *PUNE, age_s=age_s)
    st = services.tracking_status(s)
    assert st["status"] == expected and st["is_live"] is (expected == "live")
    assert st["age_s"] == pytest.approx(age_s, abs=3)


def test_status_without_a_fix_or_without_duty(sam):
    open_session = go_on_duty(sam)
    assert services.tracking_status(open_session)["status"] == "no_fix"
    assert services.tracking_status(None)["status"] == "off_duty"
    open_session.ended_at = timezone.now()
    assert services.tracking_status(open_session)["status"] == "off_duty"


def test_synced_backlog_does_not_make_an_old_position_look_live(sam):
    """Fixes captured 40 minutes ago but uploaded now: accepted, yet the status is 'lost', never 'live'."""
    now = timezone.now()
    go_on_duty(sam, started_ago=minutes(90), now=now)
    services.ingest_points(sam, [point(at=now - minutes(40))], now=now)
    s = WorkSession.objects.get()
    assert s.last_fix_at == now - minutes(40)
    assert services.tracking_status(s, now)["status"] == "lost"


def test_older_fix_never_overwrites_a_newer_last_position(sam):
    now = timezone.now()
    go_on_duty(sam, started_ago=minutes(90), now=now)
    services.ingest_points(sam, [point(19.0, 73.0, at=now - minutes(1))], now=now)
    r = services.ingest_points(sam, [point(20.0, 74.0, at=now - minutes(30))], now=now)
    s = WorkSession.objects.get()
    assert r.accepted == 1 and s.ping_count == 2
    assert float(s.last_lat) == 19.0 and s.last_fix_at == now - minutes(1)


# ---- ingest validation ------------------------------------------------------------------------------

def reasons(result):
    return sorted(r["reason"] for r in result.rejected)


def test_ingest_requires_a_declared_duty_session(sam):
    r = services.ingest_points(sam, [point()])
    assert r.accepted == 0 and reasons(r) == ["no_session"]
    assert LocationPing.objects.count() == 0


def test_accepts_valid_points_and_stores_server_validated_time(sam):
    now = timezone.now()
    go_on_duty(sam, now=now)
    r = services.ingest_points(sam, [point(at=now - seconds(20), accuracy=12.5)], now=now)
    p = LocationPing.objects.get()
    assert r.accepted == 1 and not r.rejected
    assert p.accuracy_m == 12.5 and p.captured_at == now - seconds(20) and p.clock_skew_s == 0
    assert p.received_at == now


def test_rejections(sam):
    now = timezone.now()
    go_on_duty(sam, started_ago=minutes(30), now=now)
    batch = [
        point(at=now - minutes(1), accuracy=5000),   # too imprecise to be useful
        point(at=now + minutes(10)),                 # from the future
        point(at=now - minutes(33)),                 # before duty began
        point(0.0, 0.0, at=now - minutes(1)),        # Null Island
        point(at=now - minutes(1)),                  # fine
    ]
    r = services.ingest_points(sam, batch, now=now)
    assert r.accepted == 1
    assert reasons(r) == ["accuracy_too_poor", "future_timestamp", "invalid_coordinates", "outside_session"]


def test_retry_of_the_same_batch_is_idempotent(sam):
    now = timezone.now()
    go_on_duty(sam, now=now)
    batch = [point(at=now - minutes(i)) for i in range(1, 6)]
    first = services.ingest_points(sam, batch, now=now)
    again = services.ingest_points(sam, batch, now=now)
    assert (first.accepted, first.duplicates) == (5, 0) and (again.accepted, again.duplicates) == (0, 5)
    assert LocationPing.objects.count() == 5 and WorkSession.objects.get().ping_count == 5


def test_duplicate_ids_inside_one_batch_count_once(sam):
    now = timezone.now()
    go_on_duty(sam, now=now)
    pid = uuid.uuid4()
    r = services.ingest_points(sam, [point(at=now - minutes(2), pid=pid), point(at=now - minutes(1), pid=pid)], now=now)
    assert (r.accepted, r.duplicates) == (1, 1)


def test_slow_device_clock_is_corrected_from_the_send_time(sam):
    """The phone's clock is 10 minutes behind. A fix it believes is 'now' must land at the true now."""
    now = timezone.now()
    go_on_duty(sam, now=now)
    device_now = now - minutes(10)
    services.ingest_points(sam, [point(at=device_now - seconds(30))], sent_at=device_now, now=now)
    p = LocationPing.objects.get()
    assert p.clock_skew_s == 600
    assert p.captured_at == now - seconds(30)
    assert p.device_captured_at == device_now - seconds(30)  # the original is kept for audit
    assert services.tracking_status(WorkSession.objects.get(), now)["status"] == "live"


def test_fast_device_clock_cannot_post_from_the_future(sam):
    now = timezone.now()
    go_on_duty(sam, now=now)
    device_now = now + minutes(20)
    r = services.ingest_points(sam, [point(at=device_now - seconds(5))], sent_at=device_now, now=now)
    assert r.accepted == 1
    assert LocationPing.objects.get().captured_at <= now  # shifted back, not accepted as a future fix


def test_small_clock_difference_is_treated_as_network_latency(sam):
    now = timezone.now()
    go_on_duty(sam, now=now)
    services.ingest_points(sam, [point(at=now - seconds(5))], sent_at=now - seconds(8), now=now)
    assert LocationPing.objects.get().clock_skew_s == 0


def test_offline_points_sync_after_the_session_ended_but_not_forever(sam):
    now = timezone.now()
    s = go_on_duty(sam, started_ago=minutes(180), now=now)
    s.ended_at = now - minutes(60)
    s.end_reason = "manual"
    s.save()
    r = services.ingest_points(sam, [point(at=now - minutes(90)), point(at=now - minutes(30))], now=now)
    assert r.accepted == 1 and reasons(r) == ["outside_session"]

    grace = timedelta(hours=settings.FIELD_TRACKING["SYNC_GRACE_H"])
    later = now + grace + minutes(5)
    r = services.ingest_points(sam, [point(at=now - minutes(100))], sent_at=later, now=later)
    assert r.accepted == 0 and reasons(r) == ["no_session"]  # the session is beyond the sync window


def test_points_are_matched_to_the_session_they_were_captured_in(sam):
    now = timezone.now()
    old = go_on_duty(sam, started_ago=minutes(300), now=now)
    old.ended_at, old.end_reason = now - minutes(200), "manual"
    old.save()
    new = go_on_duty(sam, started_ago=minutes(60), now=now)
    services.ingest_points(sam, [point(at=now - minutes(250)), point(at=now - minutes(10))], now=now)
    assert LocationPing.objects.get(session=old).captured_at == now - minutes(250)
    assert LocationPing.objects.get(session=new).captured_at == now - minutes(10)


# ---- HTTP layer ----------------------------------------------------------------------------------------

def test_full_duty_flow_over_http(sam):
    c = api(sam.user)
    assert c.get("/api/field/session/").data["on_duty"] is False
    assert c.post("/api/field/session/start/", {"consent": False, "consent_version": CONSENT}, format="json").status_code == 400
    r = c.post("/api/field/session/start/", {"consent": True, "consent_version": CONSENT}, format="json")
    assert r.status_code == 201 and r.data["on_duty"] and r.data["tracking"]["status"] == "no_fix"
    assert c.post("/api/field/session/start/", {"consent": True, "consent_version": CONSENT}, format="json").status_code == 200

    body = {"sent_at": timezone.now().isoformat(), "points": [payload_point(), payload_point(accuracy=7)]}
    r = c.post("/api/field/locations/", body, format="json")
    assert r.status_code == 200 and r.data["accepted"] == 2 and r.data["tracking"]["status"] == "live"
    assert c.post("/api/field/locations/", body, format="json").data["duplicates"] == 2

    st = c.get("/api/field/session/").data
    assert st["session"]["ping_count"] == 2 and st["session"]["last_fix"]["accuracy_m"] in (10.0, 7.0)
    assert any("Start duty" in line for line in st["policy"]["notice"])

    r = c.post("/api/field/session/end/")
    assert r.data["on_duty"] is False and r.data["tracking"]["status"] == "off_duty"
    # Unambiguously after End: the clock ticks coarsely on Windows, so "now" can equal ended_at, which is still inside duty.
    after_end = payload_point(at=timezone.now() + timedelta(seconds=2))
    r = c.post("/api/field/locations/", {"points": [after_end]}, format="json")
    assert r.data["accepted"] == 0 and r.data["on_duty"] is False  # tracking stops with the duty session
    assert r.data["rejected"][0]["reason"] == "outside_session"


def _raw(**over):
    p = {"client_point_id": str(uuid.uuid4()), "latitude": 1, "longitude": 1, "accuracy_m": 1,
         "captured_at": "2026-01-01T00:00:00Z"}
    p.update(over)
    return {"points": [p]}


@pytest.mark.parametrize("bad", [
    {"points": []},
    {},
    _raw(client_point_id="nope"),
    _raw(latitude="NaN"),
    _raw(latitude=91),
    _raw(accuracy_m="Infinity"),
    _raw(accuracy_m=-3),
])
def test_malformed_batches_are_rejected_wholesale(sam, bad):
    go_on_duty(sam)
    assert api(sam.user).post("/api/field/locations/", bad, format="json").status_code == 400


def test_batch_size_is_capped(sam):
    go_on_duty(sam)
    big = {"points": [payload_point() for _ in range(settings.FIELD_TRACKING["MAX_BATCH"] + 1)]}
    assert api(sam.user).post("/api/field/locations/", big, format="json").status_code == 400


def test_upload_endpoint_is_rate_limited(sam):
    go_on_duty(sam)
    c = api(sam.user)
    codes = [c.post("/api/field/locations/", {"points": [payload_point()]}, format="json").status_code for _ in range(62)]
    assert codes.count(200) == 60 and codes[-1] == 429


def test_high_precision_coordinates_from_a_real_browser_are_accepted(sam):
    go_on_duty(sam)
    p = payload_point(lat=18.520430123456789, lng=73.856743987654321)
    assert api(sam.user).post("/api/field/locations/", {"points": [p]}, format="json").data["accepted"] == 1
    assert float(LocationPing.objects.get().latitude) == 18.52043


def test_session_window_is_strict_at_both_ends(sam):
    now = timezone.now()
    s = go_on_duty(sam, started_ago=minutes(60), now=now)
    s.ended_at, s.end_reason = now - minutes(10), "manual"
    s.save()
    start, end = s.started_at, s.ended_at
    r = services.ingest_points(sam, [
        point(at=start - seconds(1)), point(at=start), point(at=end), point(at=end + seconds(1)),
    ], now=now)
    assert r.accepted == 2 and reasons(r) == ["outside_session", "outside_session"]
    assert sorted(p.captured_at for p in LocationPing.objects.all()) == [start, end]
