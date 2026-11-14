import io
import uuid
from datetime import timedelta

import pytest
from django.core.files.uploadedfile import SimpleUploadedFile
from django.core.management import call_command
from django.utils import timezone
from PIL import Image

from apps.accounts.models import Role
from apps.dealers.models import Dealer
from apps.field.helpers import PUNE, api, go_on_duty, make_dealer, make_salesman, make_user
from apps.visits.models import Visit, VisitPhoto

pytestmark = pytest.mark.django_db

UP, REC = "/api/visits/photos/", "/api/visits/record/"


def jpeg(size=(800, 600), gps=False, orientation=None, color=(200, 30, 30)) -> bytes:
    img = Image.new("RGB", size, color)
    exif = Image.Exif()
    if gps:
        ifd = exif.get_ifd(0x8825)
        ifd[1], ifd[2], ifd[3], ifd[4] = "N", (18.0, 31.0, 13.0), "E", (73.0, 51.0, 24.0)
    if orientation:
        exif[274] = orientation
    out = io.BytesIO()
    img.save(out, format="JPEG", exif=exif if (gps or orientation) else Image.Exif())
    return out.getvalue()


def upload(client, data=None, name="car.jpg", ctype="image/jpeg", **extra):
    f = SimpleUploadedFile(name, data if data is not None else jpeg(), content_type=ctype)
    return client.post(UP, {"image": f, **extra}, format="multipart")


@pytest.fixture
def sam():
    return make_salesman("sam")


@pytest.fixture
def need2(settings):
    settings.VISIT_MIN_PHOTOS = 2


def stage(client, n=2):
    return [upload(client).data["id"] for _ in range(n)]


def visit_body(dealer, photo_ids=None, **kw):
    b = {"dealer_id": dealer.id, "client_request_id": str(uuid.uuid4()), "notes": "ok", **kw}
    if photo_ids is not None:
        b["photo_ids"] = photo_ids
    return b


# ---- upload: only real images, stored clean --------------------------------------------------------------

def test_upload_stores_a_clean_downsized_jpeg_without_the_shops_gps(sam):
    raw = jpeg(size=(3200, 2400), gps=True)
    assert Image.open(io.BytesIO(raw)).getexif().get_ifd(0x8825), "test image must carry GPS to prove it is removed"
    r = upload(api(sam.user), raw)
    assert r.status_code == 201, r.data
    p = VisitPhoto.objects.get(pk=r.data["id"])
    assert p.visit_id is None and p.kind == "car" and p.salesman == sam
    stored = Image.open(p.image.path)
    assert stored.format == "JPEG" and max(stored.size) == 2000 and stored.size == (2000, 1500)
    assert not stored.getexif() and "exif" not in stored.info  # location and every other metadata tag gone
    assert (p.width, p.height) == (2000, 1500) and p.size_bytes == p.image.size
    assert r.data["url"] == f"/api/visits/photos/{p.id}/image/" and p.image.name.endswith(".jpg") and "car.jpg" not in p.image.name


def test_orientation_is_baked_in_so_a_portrait_phone_photo_is_not_sideways(sam):
    r = upload(api(sam.user), jpeg(size=(300, 200), orientation=6))  # "rotate 90": the camera stored it landscape
    assert (r.data["width"], r.data["height"]) == (200, 300)


def test_png_with_transparency_and_webp_are_accepted_and_flattened_onto_white(sam):
    out = io.BytesIO()
    Image.new("RGBA", (50, 50), (0, 0, 0, 0)).save(out, format="PNG")
    r = upload(api(sam.user), out.getvalue(), "t.png", "image/png")
    assert r.status_code == 201
    px = Image.open(VisitPhoto.objects.get(pk=r.data["id"]).image.path).getpixel((10, 10))
    assert min(px) > 240  # white, not black
    out = io.BytesIO()
    Image.new("RGB", (60, 40), "blue").save(out, format="WEBP")
    assert upload(api(sam.user), out.getvalue(), "w.webp", "image/webp").status_code == 201


@pytest.mark.parametrize("name,data", [
    ("evil.jpg", b"<html><script>alert(1)</script></html>"),           # claims to be a photo, is not
    ("empty.jpg", b""),
    ("cut.jpg", jpeg()[:200]),                                          # truncated
    ("anim.gif", None),                                                 # a real image, but not an allowed format
])
def test_non_photos_are_refused(sam, name, data):
    if data is None:
        out = io.BytesIO()
        Image.new("P", (10, 10)).save(out, format="GIF")
        data = out.getvalue()
    r = upload(api(sam.user), data, name)
    assert r.status_code == 400 and "image" in r.data
    assert VisitPhoto.objects.count() == 0


def test_size_field_and_kind_validation(sam, monkeypatch):
    c = api(sam.user)
    assert c.post(UP, {}, format="multipart").status_code == 400
    assert upload(c, kind="bogus").status_code == 400
    from apps.visits import photos
    monkeypatch.setattr(photos, "MAX_UPLOAD_BYTES", 1000)
    assert upload(c).status_code == 400  # a 15 MB-style limit, shrunk for the test


def test_too_many_unattached_photos_are_refused(sam, monkeypatch):
    from apps.visits import photos
    monkeypatch.setattr(photos, "MAX_PENDING", 2)
    c = api(sam.user)
    assert upload(c).status_code == 201 and upload(c).status_code == 201
    assert upload(c).status_code == 400


def test_only_salesmen_upload(sam):
    assert upload(api(make_user("mgr", Role.MANAGER))).status_code == 403
    from rest_framework.test import APIClient
    assert upload(APIClient()).status_code == 401


# ---- serving: private ------------------------------------------------------------------------------------

def test_photos_are_served_only_to_the_owner_and_management(sam):
    pid = upload(api(sam.user)).data["id"]
    url = f"/api/visits/photos/{pid}/image/"
    r = api(sam.user).get(url)
    assert r.status_code == 200 and r["Content-Type"] == "image/jpeg" and r["X-Content-Type-Options"] == "nosniff"
    assert "private" in r["Cache-Control"] and Image.open(io.BytesIO(b"".join(r.streaming_content))).format == "JPEG"
    assert api(make_user("boss", Role.MANAGER)).get(url).status_code == 200
    assert api(make_salesman("rival").user).get(url).status_code == 404   # not "403": existence is not revealed
    from rest_framework.test import APIClient
    assert APIClient().get(url).status_code == 401
    VisitPhoto.objects.filter(pk=pid).update(image="visit_photos/1/missing.jpg")
    assert api(sam.user).get(url).status_code == 404                       # file lost on disk: a clean 404, not a 500


def test_a_staged_photo_can_be_removed_but_a_saved_one_cannot(sam, need2):
    c = api(sam.user)
    pid = upload(c).data["id"]
    path = VisitPhoto.objects.get(pk=pid).image.path
    assert c.delete(f"{UP}{pid}/").status_code == 204 and not VisitPhoto.objects.filter(pk=pid).exists()
    import os
    assert not os.path.exists(path)
    dealer = make_dealer("D", *PUNE, owner=sam)
    ids = stage(c)
    assert c.post(REC, visit_body(dealer, ids), format="json").status_code == 201
    assert c.delete(f"{UP}{ids[0]}/").status_code == 404
    assert api(make_salesman("rival").user).delete(f"{UP}{upload(c).data['id']}/").status_code == 404


# ---- the rule: at least 2 car photos, enforced by the server ----------------------------------------------

def test_rules_endpoint_tells_the_form_what_is_required(sam, need2):
    r = api(sam.user).get("/api/visits/photo-rules/").data
    assert r["min_car_photos"] == 2 and r["max_photos"] == 12 and r["kinds"] == [{"value": "car", "label": "Car photo"}]


@pytest.mark.parametrize("have", [0, 1])
def test_a_visit_with_fewer_than_two_car_photos_is_refused_and_nothing_is_written(sam, need2, have):
    c = api(sam.user)
    body = {"new_dealer": {"name": "Brand New Motors", "phone": "9123456780", "city": "Pune"}, "client_request_id": str(uuid.uuid4()),
            "photo_ids": stage(c, have)}
    r = c.post(REC, body, format="json")
    assert r.status_code == 400 and "at least 2 car photos" in str(r.data["photo_ids"]) and f"you have {have}" in str(r.data["photo_ids"])
    assert Visit.objects.count() == 0 and not Dealer.objects.filter(name="Brand New Motors").exists()
    assert VisitPhoto.objects.filter(visit__isnull=False).count() == 0
    r = c.post(REC, {k: v for k, v in body.items() if k != "photo_ids"}, format="json")  # photo_ids omitted entirely
    assert r.status_code == 400 and "photo_ids" in r.data


def test_two_car_photos_save_the_visit_and_attach_them(sam, need2):
    c = api(sam.user)
    dealer = make_dealer("D", *PUNE, owner=sam)
    ids = stage(c, 3)
    r = c.post(REC, visit_body(dealer, ids), format="json")
    assert r.status_code == 201, r.data
    v = Visit.objects.get()
    assert sorted(p.id for p in v.photos.all()) == sorted(ids) and all(p.kind == "car" for p in v.photos.all())


def test_photos_belonging_to_someone_else_or_already_used_cannot_be_attached(sam, need2):
    c = api(sam.user)
    dealer = make_dealer("D", *PUNE, owner=sam)
    theirs = stage(api(make_salesman("rival").user), 2)
    r = c.post(REC, visit_body(dealer, theirs), format="json")
    assert r.status_code == 400 and "not found or were already used" in str(r.data["photo_ids"])
    mine = stage(c)
    assert c.post(REC, visit_body(dealer, mine), format="json").status_code == 201
    again = c.post(REC, visit_body(dealer, mine), format="json")  # a different visit trying to reuse them
    assert again.status_code == 400 and Visit.objects.count() == 1
    assert c.post(REC, visit_body(dealer, [999999, 999998]), format="json").status_code == 400


def test_repeating_the_same_ids_does_not_inflate_the_count(sam, need2):
    c = api(sam.user)
    dealer = make_dealer("D", *PUNE, owner=sam)
    one = stage(c, 1)
    assert c.post(REC, visit_body(dealer, one * 2), format="json").status_code == 400  # one photo twice is still one photo


def test_a_retry_of_a_saved_visit_is_still_idempotent(sam, need2):
    c = api(sam.user)
    dealer = make_dealer("D", *PUNE, owner=sam)
    body = visit_body(dealer, stage(c))
    assert c.post(REC, body, format="json").status_code == 201
    r = c.post(REC, body, format="json")  # photos are already attached; the retry must not demand or move them
    assert r.status_code == 200 and r.data["created"] is False and Visit.objects.count() == 1 and Visit.objects.get().photos.count() == 2


def test_the_rule_can_be_switched_off_and_at_most_twelve_photos_are_allowed(sam, settings):
    c = api(sam.user)
    dealer = make_dealer("D", *PUNE, owner=sam)
    settings.VISIT_MIN_PHOTOS = 0
    assert c.post(REC, visit_body(dealer), format="json").status_code == 201
    assert c.post(REC, visit_body(dealer, list(range(1, 14))), format="json").status_code == 400


# ---- where photos show up -----------------------------------------------------------------------------------

def test_photos_appear_on_both_visit_detail_pages(sam, need2):
    c = api(sam.user)
    dealer = make_dealer("D", *PUNE, owner=sam)
    ids = stage(c)
    vid = c.post(REC, visit_body(dealer, ids), format="json").data["visit_id"]
    mine = c.get(f"/api/salesman/visits/{vid}/").data["photos"]
    boss = api(make_user("boss", Role.MANAGER)).get(f"/api/management/visits/{vid}/").data["photos"]
    assert sorted(p["id"] for p in mine) == sorted(ids) == sorted(p["id"] for p in boss)
    assert all(p["url"].endswith("/image/") for p in boss) and boss[0]["kind"] == "car"


def test_field_check_out_needs_the_same_two_photos(sam, need2):
    go_on_duty(sam)
    dealer = make_dealer("Sharma", *PUNE, owner=sam)
    c = api(sam.user)
    pos = {"latitude": PUNE[0], "longitude": PUNE[1], "accuracy_m": 10, "captured_at": (timezone.now() - timedelta(seconds=3)).isoformat()}
    cid = c.post("/api/field/checkins/", {"dealer_id": dealer.id, "position": pos}, format="json").data["id"]
    out = {"position": pos, "outcome": "interested", "notes": "n"}
    r = c.post(f"/api/field/checkins/{cid}/check-out/", out, format="json")
    assert r.status_code == 400 and "photo_ids" in r.data
    from apps.field.models import DealerCheckIn
    assert DealerCheckIn.objects.get().checked_out_at is None
    r = c.post(f"/api/field/checkins/{cid}/check-out/", {**out, "photo_ids": stage(c)}, format="json")
    assert r.status_code == 200 and Visit.objects.get().photos.count() == 2


# ---- housekeeping ---------------------------------------------------------------------------------------------

def test_abandoned_uploads_are_purged_but_saved_and_recent_ones_are_kept(sam, need2, capsys):
    c = api(sam.user)
    dealer = make_dealer("D", *PUNE, owner=sam)
    old, recent = upload(c).data["id"], upload(c).data["id"]
    saved = stage(c)
    c.post(REC, visit_body(dealer, saved), format="json")
    VisitPhoto.objects.filter(pk__in=[old] + saved).update(created_at=timezone.now() - timedelta(hours=30))
    path = VisitPhoto.objects.get(pk=old).image.path
    call_command("purge_orphan_photos", "--dry-run")
    assert "would remove 1" in capsys.readouterr().out and VisitPhoto.objects.filter(pk=old).exists()
    call_command("purge_orphan_photos")
    assert "Removed 1" in capsys.readouterr().out
    import os
    assert not VisitPhoto.objects.filter(pk=old).exists() and not os.path.exists(path)
    assert VisitPhoto.objects.filter(pk=recent).exists() and VisitPhoto.objects.filter(pk__in=saved).count() == 2
