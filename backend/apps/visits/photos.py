"""Visit photos: validation, sanitising, and attaching them to a visit.

Uploads are staged first (``visit`` is NULL) and attached when the visit is saved, so the existing JSON visit
endpoint stays atomic: the visit, its order lines and its photos are written in one transaction, and a visit that
is short of photos is refused before anything is created.
"""
import io
import uuid

from django.conf import settings
from django.core.files.base import ContentFile
from PIL import Image, ImageOps, UnidentifiedImageError
from rest_framework.exceptions import ValidationError

from .models import VisitPhoto

MAX_UPLOAD_BYTES = 15 * 1024 * 1024  # a raw phone photo; the app compresses far below this before sending
MAX_SIDE = 2000                      # pixels, longest side, after re-encoding
JPEG_QUALITY = 85
MAX_PENDING = 30                     # staged-but-unattached photos per salesman
MAX_PER_VISIT = 12
ALLOWED_FORMATS = {"JPEG", "PNG", "WEBP"}


def rules() -> dict:
    return {
        "min_car_photos": settings.VISIT_MIN_PHOTOS,
        "max_photos": MAX_PER_VISIT,
        "max_upload_mb": MAX_UPLOAD_BYTES // (1024 * 1024),
        "kinds": [{"value": k, "label": label} for k, label in VisitPhoto.Kind.choices],
    }


def save_upload(salesman, uploaded, kind=VisitPhoto.Kind.CAR) -> VisitPhoto:
    """Validate that ``uploaded`` is a real image, then store a clean re-encoded JPEG.

    Re-encoding (rather than keeping the original bytes) means nothing hostile survives inside the file, EXIF is
    dropped (phone photos carry the GPS position of the shop), orientation is baked in, and size is bounded."""
    if kind not in VisitPhoto.Kind.values:
        raise ValidationError({"kind": "Unknown photo type"})
    if uploaded.size > MAX_UPLOAD_BYTES:
        raise ValidationError({"image": f"That photo is too large (limit {MAX_UPLOAD_BYTES // (1024 * 1024)} MB)."})
    if VisitPhoto.objects.filter(salesman=salesman, visit__isnull=True).count() >= MAX_PENDING:
        raise ValidationError({"image": "Too many photos are waiting to be attached. Save or remove some first."})
    try:
        img = Image.open(uploaded)
        fmt = img.format
        img.load()  # decodes fully: truncated or corrupt files fail here, not later
    except (UnidentifiedImageError, OSError, Image.DecompressionBombError, ValueError, SyntaxError):
        raise ValidationError({"image": "That file is not a usable photo. Use a JPEG, PNG or WebP image."})
    if fmt not in ALLOWED_FORMATS:
        raise ValidationError({"image": "Only JPEG, PNG or WebP photos are accepted."})

    img = ImageOps.exif_transpose(img)
    if img.mode not in ("RGB", "L"):
        background = Image.new("RGB", img.size, "white")  # flatten transparency instead of turning it black
        background.paste(img.convert("RGBA"), mask=img.convert("RGBA").split()[-1])
        img = background
    elif img.mode == "L":
        img = img.convert("RGB")
    img.thumbnail((MAX_SIDE, MAX_SIDE), Image.LANCZOS)
    out = io.BytesIO()
    img.save(out, format="JPEG", quality=JPEG_QUALITY, optimize=True)  # no exif= argument: metadata is not carried over
    data = out.getvalue()

    photo = VisitPhoto(salesman=salesman, kind=kind, width=img.width, height=img.height, size_bytes=len(data))
    photo.image.save(f"{uuid.uuid4().hex}.jpg", ContentFile(data), save=False)
    photo.save()
    return photo


def check_photo_ids(salesman, photo_ids, *, lock=False):
    """The staged photos for ``photo_ids``, or a ValidationError. Enforces the minimum number of car photos."""
    ids = list(dict.fromkeys(photo_ids or []))  # drop duplicates, keep order
    qs = VisitPhoto.objects.filter(pk__in=ids, salesman=salesman, visit__isnull=True)
    photos = list(qs.select_for_update() if lock else qs)
    if len(photos) != len(ids):
        raise ValidationError({"photo_ids": "One or more photos were not found or were already used. Please add them again."})
    if len(photos) > MAX_PER_VISIT:
        raise ValidationError({"photo_ids": f"A visit can have at most {MAX_PER_VISIT} photos."})
    cars = sum(1 for p in photos if p.kind == VisitPhoto.Kind.CAR)
    need = settings.VISIT_MIN_PHOTOS
    if cars < need:
        raise ValidationError({"photo_ids": f"Add at least {need} car photos before saving the visit (you have {cars})."})
    return photos


def attach(salesman, visit, photo_ids):
    photos = check_photo_ids(salesman, photo_ids, lock=True)  # re-checked under the transaction's lock
    if photos:
        VisitPhoto.objects.filter(pk__in=[p.pk for p in photos]).update(visit=visit)


def photo_url(photo_id: int) -> str:
    return f"/api/visits/photos/{photo_id}/image/"


def photos_payload(visit) -> list[dict]:
    return [{"id": p.id, "kind": p.kind, "url": photo_url(p.id), "width": p.width, "height": p.height}
            for p in visit.photos.all()]


def remove_file(photo) -> None:
    """Delete the stored file. A file that is busy (being downloaded, on Windows) must not block deleting the row."""
    try:
        photo.image.delete(save=False)
    except OSError:
        pass


def purge_orphans(older_than_hours=24, dry_run=False) -> int:
    """Delete staged photos that never made it onto a visit (abandoned forms), files included."""
    from datetime import timedelta

    from django.utils import timezone

    stale = VisitPhoto.objects.filter(visit__isnull=True, created_at__lt=timezone.now() - timedelta(hours=older_than_hours))
    n = stale.count()
    if not dry_run:
        for p in stale:
            remove_file(p)
            p.delete()
    return n
