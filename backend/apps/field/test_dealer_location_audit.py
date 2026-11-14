from datetime import timedelta

import pytest
from django.core.management import call_command
from django.utils import timezone

from apps.accounts.models import Role, SalesmanTerritory
from apps.dealers.models import DealerContact
from apps.field import services
from apps.field.helpers import KM, PUNE, api, go_on_duty, make_dealer, make_salesman, make_user, point, set_fix
from apps.field.models import FieldAuditLog, FieldConfig, LocationPing, WorkSession

pytestmark = pytest.mark.django_db


@pytest.fixture
def mgr():
    return api(make_user("mgr", Role.MANAGER))


@pytest.fixture
def admin():
    return api(make_user("adm", Role.ADMIN))


def loc(d):
    return f"/api/management/dealers/{d.id}/location/"


# ---- dealer location master ---------------------------------------------------------------------------

def test_set_and_verify_a_dealer_location(mgr):
    d = make_dealer("Sharma Auto", city="Pune", state="Maharashtra")
    r = mgr.put(loc(d), {"latitude": 18.5204, "longitude": 73.8567, "source": "map_pin", "verified": True, "accuracy_m": 8}, format="json")
    assert r.status_code == 200
    assert r.data["latitude"] == 18.5204 and r.data["verified"] and r.data["verified_by"] == "mgr"
    d.refresh_from_db()
    assert float(d.latitude) == 18.5204 and d.location_source == "map_pin" and d.location_verified_at is not None
    assert d.location_verified_by.username == "mgr" and d.location_accuracy_m == 8


def test_moving_a_pin_clears_an_earlier_verification(mgr):
    d = make_dealer("D", *PUNE)
    mgr.post(loc(d) + "verify/")
    d.refresh_from_db()
    assert d.location_verified_at is not None
    mgr.put(loc(d), {"latitude": 18.6, "longitude": 73.9}, format="json")  # verified defaults to False
    d.refresh_from_db()
    assert float(d.latitude) == 18.6 and d.location_verified_at is None and d.location_verified_by is None


def test_verify_keeps_the_coordinates_and_refuses_when_there_are_none(mgr):
    d = make_dealer("D", *PUNE)
    r = mgr.post(loc(d) + "verify/")
    assert r.status_code == 200 and r.data["verified"] and r.data["latitude"] == PUNE[0]
    assert mgr.post(loc(make_dealer("none")) + "verify/").status_code == 400
    assert mgr.post(loc(make_dealer("island", 0, 0)) + "verify/").status_code == 400
    assert mgr.post("/api/management/dealers/999999/location/verify/").status_code == 404


@pytest.mark.parametrize("body", [
    {"latitude": 0, "longitude": 0}, {"latitude": 91, "longitude": 10}, {"latitude": 10, "longitude": 181},
    {"latitude": "nan", "longitude": 10}, {"latitude": 10}, {"latitude": 10, "longitude": 10, "source": "gps_checkin"},
    {"latitude": 10, "longitude": 10, "geofence_radius_m": 5}, {"latitude": 10, "longitude": 10, "accuracy_m": -1},
])
def test_bad_dealer_locations_are_rejected(mgr, body):
    d = make_dealer("D")
    assert mgr.put(loc(d), body, format="json").status_code == 400
    d.refresh_from_db()
    assert d.latitude is None


def test_per_dealer_geofence_override_is_stored(mgr):
    d = make_dealer("D")
    mgr.put(loc(d), {"latitude": 10, "longitude": 20, "geofence_radius_m": 300}, format="json")
    d.refresh_from_db()
    assert d.geofence_radius_m == 300


def test_location_changes_are_audited_with_before_and_after(mgr):
    d = make_dealer("D", 10.0, 20.0)
    mgr.put(loc(d), {"latitude": 11.0, "longitude": 21.0}, format="json")
    mgr.post(loc(d) + "verify/")
    a = FieldAuditLog.objects.get(action="dealer_location_set")
    assert a.actor_username == "mgr" and a.dealer_id == d.id
    assert a.detail["before"]["latitude"] == "10.000000" and a.detail["after"]["latitude"] == 11.0
    assert FieldAuditLog.objects.filter(action="dealer_location_verify", dealer_id=d.id).count() == 1


def test_location_master_list_summary_filters_territory_and_contact(mgr):
    sam = make_salesman("sam")
    SalesmanTerritory.objects.create(salesman=sam, state="Maharashtra", city="Pune")
    SalesmanTerritory.objects.create(salesman=sam, state="Gujarat")
    ok = make_dealer("Verified", *PUNE, city="Pune", state="Maharashtra")
    ok.location_verified_at = timezone.now()
    ok.save()
    DealerContact.objects.create(dealer=ok, name="Raj", phone="9876543210")
    make_dealer("Unverified", PUNE[0] + KM, PUNE[1], city="Surat", state="Gujarat")
    make_dealer("Missing", city="Pune", state="Maharashtra")
    make_dealer("Island", 0, 0)
    make_dealer("Archived", is_archived=True)

    r = mgr.get("/api/management/field/dealer-locations/").data
    assert r["summary"] == {"total": 4, "verified": 1, "unverified": 1, "missing": 2}
    rows = {x["name"]: x for x in r["results"]}
    assert rows["Verified"]["territory"] == {"state": "Maharashtra", "city": "Pune", "covered_by": ["sam"]}
    assert rows["Verified"]["contact"] == {"name": "Raj", "phone": "9876543210"} and rows["Verified"]["has_location"]
    assert rows["Unverified"]["territory"]["covered_by"] == ["sam"]  # state-wide territory covers every city
    assert rows["Missing"]["has_location"] is False and rows["Island"]["has_location"] is False
    for status, want in {"verified": {"Verified"}, "unverified": {"Unverified"}, "missing": {"Missing", "Island"}}.items():
        got = mgr.get("/api/management/field/dealer-locations/", {"status": status}).data["results"]
        assert {x["name"] for x in got} == want
    assert mgr.get("/api/management/field/dealer-locations/", {"q": "verif"}).data["count"] == 2


def test_existing_dealer_pages_are_unchanged_by_the_new_columns(mgr):
    d = make_dealer("Old", 10.0, 20.0, city="Pune")
    r = mgr.get(f"/api/dealers/{d.id}/")
    assert r.status_code == 200 and r.data["profile"]["name"] == "Old"
    assert mgr.patch(f"/api/dealers/{d.id}/", {"city": "Mumbai"}, format="json").status_code == 200


# ---- audit ---------------------------------------------------------------------------------------------

def test_route_history_is_returned_for_the_day_and_always_audited(mgr):
    sam = make_salesman("sam")
    now = timezone.now()
    go_on_duty(sam, started_ago=timedelta(hours=2), now=now)
    services.ingest_points(sam, [point(at=now - timedelta(minutes=i)) for i in (50, 40, 30)], now=now)
    r = mgr.get(f"/api/management/field/salesmen/{sam.id}/track/").data
    assert r["total_points"] == 3 and len(r["points"]) == 3 and r["downsampled"] is False
    assert [p["captured_at"] for p in r["points"]] == sorted(p["captured_at"] for p in r["points"])
    assert len(r["sessions"]) == 1
    a = FieldAuditLog.objects.get(action="track_view")
    assert a.actor_username == "mgr" and a.salesman_id == sam.id and a.detail["points"] == 3
    assert mgr.get(f"/api/management/field/salesmen/{sam.id}/track/", {"date": "2020-01-01"}).data["total_points"] == 0
    assert FieldAuditLog.objects.filter(action="track_view").count() == 2  # even an empty day is a view
    assert mgr.get(f"/api/management/field/salesmen/{sam.id}/track/", {"date": "yesterday"}).status_code == 400
    assert mgr.get("/api/management/field/salesmen/999999/track/").status_code == 404


def test_long_routes_are_downsampled_and_say_so(mgr, monkeypatch):
    from apps.field import mgmt_views
    monkeypatch.setattr(mgmt_views, "MAX_TRACK_POINTS", 10)
    sam = make_salesman("sam")
    now = timezone.now()
    go_on_duty(sam, started_ago=timedelta(hours=3), now=now)
    services.ingest_points(sam, [point(at=now - timedelta(minutes=i)) for i in range(1, 36)], now=now)
    r = mgr.get(f"/api/management/field/salesmen/{sam.id}/track/").data
    assert r["total_points"] == 35 and r["downsampled"] and len(r["points"]) <= 10


def test_live_map_status_and_privacy_of_off_duty_salesmen(mgr):
    live, stale, off, idle = (make_salesman(n) for n in ("live", "stale", "off", "idle"))
    set_fix(go_on_duty(live), 19.0, 73.0, age_s=15, accuracy=20)
    set_fix(go_on_duty(stale), 19.1, 73.1, age_s=500, accuracy=200)
    go_on_duty(idle)
    done = go_on_duty(off)
    set_fix(done, 19.2, 73.2, age_s=4000)
    services.end_session(off.user, off)
    r = mgr.get("/api/management/field/live/").data
    rows = {x["name"]: x for x in r["salesmen"]}
    assert rows["live"]["status"] == "live" and rows["live"]["is_live"] and rows["live"]["last_fix"]["quality"] == "good"
    assert rows["stale"]["status"] == "stale" and rows["stale"]["is_live"] is False and rows["stale"]["age_s"] >= 495
    assert rows["stale"]["last_fix"]["quality"] == "poor"
    assert rows["idle"]["status"] == "no_fix" and rows["idle"]["last_fix"] is None
    assert rows["off"]["status"] == "off_duty" and rows["off"]["last_fix"] is None  # no coordinates for off-duty staff
    assert rows["off"]["last_duty_ended_at"] is not None
    assert r["counts"] == {"live": 1, "stale": 1, "lost": 0, "no_fix": 1, "off_duty": 1}
    assert [x["status"] for x in r["salesmen"]] == ["live", "stale", "no_fix", "off_duty"]
    assert r["thresholds"] == {"live_s": 120, "stale_s": 900}


def test_inactive_salesmen_drop_off_the_map(mgr):
    gone = make_salesman("gone", active=False)
    set_fix(go_on_duty(gone), *PUNE, age_s=5)
    assert mgr.get("/api/management/field/live/").data["salesmen"] == []


def test_polled_map_views_are_audited_once_per_window(mgr):
    for _ in range(5):
        mgr.get("/api/management/field/live/")
    assert FieldAuditLog.objects.filter(action="map_view").count() == 1


def test_reverse_search_is_audited(mgr):
    d = make_dealer("D", *PUNE)
    mgr.get(f"/api/management/field/dealers/{d.id}/nearest-salesmen/")
    a = FieldAuditLog.objects.get(action="reverse_search")
    assert a.dealer_id == d.id and a.detail["kind"] == "nearest_salesmen"


def test_admin_can_force_end_a_session_and_it_is_audited(admin, mgr):
    sam = make_salesman("sam")
    go_on_duty(sam)
    assert mgr.post(f"/api/management/field/salesmen/{sam.id}/end-session/").status_code == 403
    r = admin.post(f"/api/management/field/salesmen/{sam.id}/end-session/")
    assert r.data["ended"] is True
    s = WorkSession.objects.get()
    assert s.end_reason == "admin" and s.ended_by.username == "adm"
    assert FieldAuditLog.objects.filter(action="session_force_end", salesman=sam).count() == 1
    assert admin.post(f"/api/management/field/salesmen/{sam.id}/end-session/").data["ended"] is False


def test_config_is_admin_editable_validated_and_audited(admin, mgr):
    r = mgr.get("/api/management/field/config/").data
    assert r["default_geofence_m"] == 150 and r["geofence_mode"] == "enforce" and r["radii_km"] == [1, 3, 5, 10, 20]
    for bad in ({"default_geofence_m": 5}, {"ping_interval_s": 1}, {"retention_days": 1}, {"geofence_mode": "yolo"}):
        body = {"default_geofence_m": 150, "geofence_mode": "enforce", "ping_interval_s": 30, "retention_days": 90, **bad}
        assert admin.put("/api/management/field/config/", body, format="json").status_code == 400
    ok = {"default_geofence_m": 250, "geofence_mode": "flag", "ping_interval_s": 45, "retention_days": 30}
    assert admin.put("/api/management/field/config/", ok, format="json").status_code == 200
    cfg = FieldConfig.get()
    assert (cfg.default_geofence_m, cfg.geofence_mode, cfg.retention_days) == (250, "flag", 30)
    a = FieldAuditLog.objects.get(action="config_change")
    assert a.detail["changes"]["default_geofence_m"] == {"from": 150, "to": 250}
    admin.put("/api/management/field/config/", ok, format="json")
    assert FieldAuditLog.objects.filter(action="config_change").count() == 1  # a no-op save is not a change
    assert FieldConfig.objects.count() == 1


def test_audit_log_is_admin_only_filterable_and_paged(admin, mgr):
    sam = make_salesman("sam")
    services.audit(sam.user, "session_start", salesman=sam)
    services.audit(None, "purge", pings=3)
    assert mgr.get("/api/management/field/audit/").status_code == 403
    r = admin.get("/api/management/field/audit/").data
    assert r["count"] == 2 and {x["actor"] for x in r["results"]} == {"sam", "system"}
    assert admin.get("/api/management/field/audit/", {"action": "purge"}).data["count"] == 1
    assert admin.get("/api/management/field/audit/", {"salesman_id": sam.id}).data["count"] == 1


# ---- retention -------------------------------------------------------------------------------------------

def test_purge_deletes_old_points_scrubs_old_positions_and_keeps_recent_data():
    sam = make_salesman("sam")
    now = timezone.now()
    cfg = FieldConfig.get()  # 90 days
    old = go_on_duty(sam, started_ago=timedelta(days=100, hours=2), now=now)
    old.ended_at, old.end_reason = now - timedelta(days=100), "manual"
    old.save()
    set_fix(old, *PUNE, age_s=int(timedelta(days=100).total_seconds()))
    LocationPing.objects.create(session=old, salesman=sam, latitude=1, longitude=1, accuracy_m=5,
                                captured_at=now - timedelta(days=100, hours=1), device_captured_at=now)
    recent = go_on_duty(sam, started_ago=timedelta(hours=1), now=now)
    services.ingest_points(sam, [point(at=now - timedelta(minutes=5))], now=now)
    FieldAuditLog.objects.create(action="purge", created_at=now - timedelta(days=400))
    keep_audit = FieldAuditLog.objects.create(action="track_view", created_at=now - timedelta(days=200))

    dry = services.purge_location_data(now=now, dry_run=True)
    assert dry["pings"] == 1 and dry["sessions_scrubbed"] == 1 and dry["audit_rows"] == 1
    assert LocationPing.objects.count() == 2

    out = services.purge_location_data(now=now)
    assert out["pings"] == 1
    assert LocationPing.objects.count() == 1 and LocationPing.objects.get().session == recent
    old.refresh_from_db()
    assert old.last_lat is None and old.last_accuracy_m is None and old.started_at is not None  # the record stays
    recent.refresh_from_db()
    assert recent.last_lat is not None
    assert not FieldAuditLog.objects.filter(created_at__lt=now - timedelta(days=365)).exists()
    assert FieldAuditLog.objects.filter(pk=keep_audit.pk).exists()
    assert FieldAuditLog.objects.filter(action="purge").count() == 1  # the purge itself is recorded
    assert cfg.retention_days == 90


def test_purge_respects_the_configured_retention_window():
    sam = make_salesman("sam")
    now = timezone.now()
    s = go_on_duty(sam, started_ago=timedelta(days=12), now=now)
    LocationPing.objects.create(session=s, salesman=sam, latitude=1, longitude=1, accuracy_m=5,
                                captured_at=now - timedelta(days=10), device_captured_at=now)
    assert services.purge_location_data(now=now)["pings"] == 0
    FieldConfig.objects.update_or_create(pk=1, defaults={"retention_days": 7})
    assert services.purge_location_data(now=now)["pings"] == 1


def test_management_commands_run(capsys):
    sam = make_salesman("sam")
    go_on_duty(sam, started_ago=timedelta(hours=40))
    call_command("close_stale_sessions")
    assert "Closed 1" in capsys.readouterr().out
    call_command("purge_location_data", "--dry-run")
    assert "dry run" in capsys.readouterr().out.lower()
