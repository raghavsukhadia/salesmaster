"""Duty sessions, GPS ingest and tracking status.

Trust model: the device is a witness, not an authority. Capture times are re-validated against the server
clock and the declared duty window, accuracy is stored and labelled, and "live" is judged from the capture
time of the newest accepted fix - never from when it happened to reach the server.
"""
import json
from dataclasses import dataclass, field
from datetime import timedelta
from decimal import Decimal

from django.conf import settings
from django.db import IntegrityError, transaction
from django.db.models import F, Q
from django.utils import timezone
from rest_framework.exceptions import ValidationError

from .geo import valid_coordinate
from .models import FieldAuditLog, FieldConfig, LocationPing, WorkSession

A = FieldAuditLog.Action


def tune(key):
    return settings.FIELD_TRACKING[key]


# --------------------------------------------------------------------------- audit

def clock_skew_seconds(now, sent_at) -> int:
    """Seconds to add to device capture times. 0 unless the device clock is off by more than the tolerance."""
    if sent_at is None:
        return 0
    delta = (now - sent_at).total_seconds()
    return int(round(delta)) if abs(delta) > tune("CLOCK_TOLERANCE_S") else 0


def audit(actor, action, *, salesman=None, dealer_id=None, **detail):
    user = actor if actor is not None and getattr(actor, "is_authenticated", False) else None
    return FieldAuditLog.objects.create(
        actor=user,
        actor_username=user.get_username() if user else "",
        action=action,
        salesman=salesman,
        dealer_id=dealer_id,
        detail=json.loads(json.dumps(detail, default=str)),
    )


def audit_throttled(actor, action, *, window=timedelta(minutes=15), **kw):
    """One row per actor/action per window, for high-frequency reads such as the polled live map."""
    since = timezone.now() - window
    if FieldAuditLog.objects.filter(actor=actor, action=action, created_at__gte=since).exists():
        return None
    return audit(actor, action, **kw)


# --------------------------------------------------------------------------- status

def accuracy_quality(accuracy_m) -> str:
    if accuracy_m is None:
        return "unknown"
    if accuracy_m <= tune("GOOD_ACCURACY_M"):
        return "good"
    return "fair" if accuracy_m <= tune("FAIR_ACCURACY_M") else "poor"


def tracking_status(session, now=None) -> dict:
    """off_duty | no_fix | live | stale | lost. Only ``live`` sets ``is_live``."""
    now = now or timezone.now()
    if session is None or session.ended_at is not None:
        return {"status": "off_duty", "is_live": False, "age_s": None}
    if session.last_fix_at is None:
        return {"status": "no_fix", "is_live": False, "age_s": None}
    age = max(0, int((now - session.last_fix_at).total_seconds()))
    if age <= tune("LIVE_MAX_AGE_S"):
        status = "live"
    elif age <= tune("STALE_MAX_AGE_S"):
        status = "stale"
    else:
        status = "lost"
    return {"status": status, "is_live": status == "live", "age_s": age}


def last_fix(session):
    if session is None or session.last_fix_at is None:
        return None
    return {
        "latitude": float(session.last_lat),
        "longitude": float(session.last_lng),
        "accuracy_m": session.last_accuracy_m,
        "quality": accuracy_quality(session.last_accuracy_m),
        "captured_at": session.last_fix_at,
    }


# --------------------------------------------------------------------------- sessions

def _close(session, reason, ended_at, by=None):
    """Idempotent: only the call that actually ends the session reports True (and audits)."""
    n = WorkSession.objects.filter(pk=session.pk, ended_at__isnull=True).update(
        ended_at=ended_at, end_reason=reason, ended_by=by
    )
    if n:
        session.ended_at, session.end_reason, session.ended_by = ended_at, reason, by
    return bool(n)


def get_active_session(salesman, now=None):
    """The open session, closing it first if it has been left running past MAX_SESSION_H."""
    now = now or timezone.now()
    session = WorkSession.objects.filter(salesman=salesman, ended_at__isnull=True).first()
    if session is None:
        return None
    limit = session.started_at + timedelta(hours=tune("MAX_SESSION_H"))
    if now >= limit:
        if _close(session, WorkSession.EndReason.AUTO_TIMEOUT, limit):
            audit(None, A.SESSION_END, salesman=salesman, session_id=session.id, reason="auto_timeout")
        return None
    return session


def start_session(user, salesman, *, consent, consent_version, now=None):
    """Returns (session, created). Starting while already on duty returns the open session."""
    if not consent or consent_version != tune("CONSENT_VERSION"):
        raise ValidationError({"consent": "You must accept the current location-tracking notice to go on duty"})
    now = now or timezone.now()
    existing = get_active_session(salesman, now)
    if existing:
        return existing, False
    try:
        with transaction.atomic():
            session = WorkSession.objects.create(
                salesman=salesman, started_at=now, consent_version=consent_version, last_contact_at=now
            )
    except IntegrityError:  # a concurrent start won the one-open-session constraint
        return WorkSession.objects.get(salesman=salesman, ended_at__isnull=True), False
    audit(user, A.SESSION_START, salesman=salesman, session_id=session.id, consent_version=consent_version)
    return session, True


def end_session(user, salesman, *, reason=WorkSession.EndReason.MANUAL, now=None):
    """Ends the open session. Returns it, or None if the salesman was not on duty."""
    now = now or timezone.now()
    session = get_active_session(salesman, now)
    if session is None:
        return None
    by = user if reason == WorkSession.EndReason.ADMIN else None
    if _close(session, reason, max(now, session.started_at), by):
        action = A.SESSION_FORCE_END if reason == WorkSession.EndReason.ADMIN else A.SESSION_END
        audit(user, action, salesman=salesman, session_id=session.id, reason=reason, pings=session.ping_count)
    return session


def close_stale_sessions(now=None) -> int:
    now = now or timezone.now()
    cutoff = now - timedelta(hours=tune("MAX_SESSION_H"))
    n = 0
    for s in WorkSession.objects.filter(ended_at__isnull=True, started_at__lte=cutoff).select_related("salesman"):
        limit = s.started_at + timedelta(hours=tune("MAX_SESSION_H"))
        if _close(s, WorkSession.EndReason.AUTO_TIMEOUT, limit):
            audit(None, A.SESSION_END, salesman=s.salesman, session_id=s.id, reason="auto_timeout")
            n += 1
    return n


# --------------------------------------------------------------------------- ingest

@dataclass
class IngestResult:
    accepted: int = 0
    duplicates: int = 0
    rejected: list = field(default_factory=list)  # [{"client_point_id": ..., "reason": ...}]


def ingest_points(salesman, points, *, sent_at=None, now=None) -> IngestResult:
    """Validate and store a batch of fixes. ``points`` are cleaned serializer dicts.

    Clock handling: if the device's own clock at send time (``sent_at``) differs from the server's by more
    than CLOCK_TOLERANCE_S, every capture time in the batch is shifted by that difference. A phone that is
    ten minutes slow therefore still produces correctly-timed fixes, and one that is ahead cannot post
    positions from the future. Fixes must also fall inside a declared duty session, strictly: a device clock
    that is off by less than CLOCK_TOLERANCE_S can lose a few seconds at the very start or end of a session,
    which is the right way round for a rule that says "no tracking outside duty".
    """
    now = now or timezone.now()
    result = IngestResult()

    skew = clock_skew_seconds(now, sent_at)

    get_active_session(salesman, now)  # closes an over-long session so it cannot keep accepting fixes
    horizon = now - timedelta(hours=tune("SYNC_GRACE_H"))
    sessions = list(
        WorkSession.objects.filter(salesman=salesman)
        .filter(Q(ended_at__isnull=True) | Q(ended_at__gte=horizon))
        .order_by("started_at")
    )
    max_future = timedelta(seconds=tune("MAX_FUTURE_S"))

    seen, staged = set(), []
    for p in points:
        pid = p["client_point_id"]
        lat, lng = round(float(p["latitude"]), 6), round(float(p["longitude"]), 6)
        reason = None
        if not valid_coordinate(lat, lng):
            reason = "invalid_coordinates"
        elif p["accuracy_m"] > tune("MAX_ACCURACY_M"):
            reason = "accuracy_too_poor"
        captured = p["captured_at"] + timedelta(seconds=skew)
        session = None
        if reason is None and captured > now + max_future:
            reason = "future_timestamp"
        if reason is None:
            # Strict window: nothing before Start or after End. (The open end is bounded by the future check.)
            session = next((s for s in sessions if s.started_at <= captured and (s.ended_at is None or captured <= s.ended_at)), None)
            if session is None:
                reason = "no_session" if not sessions else "outside_session"
        if reason:
            result.rejected.append({"client_point_id": str(pid), "reason": reason})
        elif pid in seen:
            result.duplicates += 1
        else:
            seen.add(pid)
            staged.append((pid, session, lat, lng, p["accuracy_m"], captured, p["captured_at"]))

    stored = set(
        LocationPing.objects.filter(salesman=salesman, client_point_id__in=[s[0] for s in staged])
        .values_list("client_point_id", flat=True)
    )
    fresh = [s for s in staged if s[0] not in stored]
    result.duplicates += len(staged) - len(fresh)

    with transaction.atomic():
        LocationPing.objects.bulk_create(
            [
                LocationPing(
                    session=session, salesman=salesman, latitude=Decimal(f"{lat:.6f}"), longitude=Decimal(f"{lng:.6f}"),
                    accuracy_m=acc, captured_at=captured, device_captured_at=device, clock_skew_s=skew,
                    received_at=now, client_point_id=pid,
                )
                for pid, session, lat, lng, acc, captured, device in fresh
            ],
            ignore_conflicts=True,
        )
        by_session = {}
        for row in fresh:
            by_session.setdefault(row[1].pk, []).append(row)
        for session_id, rows in by_session.items():
            WorkSession.objects.filter(pk=session_id).update(ping_count=F("ping_count") + len(rows), last_contact_at=now)
            _pid, _s, lat, lng, acc, captured, _device = max(rows, key=lambda r: r[5])
            # Monotonic: an older backlog never overwrites a newer position.
            WorkSession.objects.filter(pk=session_id).filter(
                Q(last_fix_at__isnull=True) | Q(last_fix_at__lt=captured)
            ).update(last_lat=Decimal(f"{lat:.6f}"), last_lng=Decimal(f"{lng:.6f}"), last_accuracy_m=acc, last_fix_at=captured)
        WorkSession.objects.filter(salesman=salesman, ended_at__isnull=True).update(last_contact_at=now)
    result.accepted = len(fresh)
    return result


# --------------------------------------------------------------------------- retention

def purge_location_data(*, now=None, dry_run=False, actor=None) -> dict:
    """Delete GPS points past the retention window, scrub last-known positions on old sessions and trim
    the audit log. Session start/end times and check-in records are kept."""
    now = now or timezone.now()
    cfg = FieldConfig.get()
    cutoff = now - timedelta(days=cfg.retention_days)
    audit_cutoff = now - timedelta(days=tune("AUDIT_RETENTION_DAYS"))

    pings = LocationPing.objects.filter(captured_at__lt=cutoff)
    scrub = WorkSession.objects.filter(ended_at__lt=cutoff, last_fix_at__isnull=False).exclude(last_lat__isnull=True)
    old_audit = FieldAuditLog.objects.filter(created_at__lt=audit_cutoff)
    out = {"pings": pings.count(), "sessions_scrubbed": scrub.count(), "audit_rows": old_audit.count(),
           "cutoff": cutoff.isoformat(), "dry_run": dry_run}
    if dry_run:
        return out
    while True:
        ids = list(pings.values_list("pk", flat=True)[:5000])
        if not ids:
            break
        LocationPing.objects.filter(pk__in=ids).delete()
    scrub.update(last_lat=None, last_lng=None, last_accuracy_m=None)
    old_audit.delete()
    audit(actor, A.PURGE, **out)
    return out
