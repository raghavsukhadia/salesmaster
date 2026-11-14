from django.conf import settings
from django.db import models
from django.db.models import F, Q
from django.utils import timezone

from apps.accounts.models import Salesman
from apps.dealers.models import Dealer


class FieldConfig(models.Model):
    """Single admin-editable row (id = 1). Code-level limits live in settings.FIELD_TRACKING."""

    class GeofenceMode(models.TextChoices):
        ENFORCE = "enforce", "Block check-in outside the geofence"
        FLAG = "flag", "Allow, but flag it for review"

    default_geofence_m = models.PositiveIntegerField(default=150)
    geofence_mode = models.CharField(max_length=8, choices=GeofenceMode.choices, default=GeofenceMode.ENFORCE)
    # Hint sent to the salesman's device: how often to record a fix while on duty.
    ping_interval_s = models.PositiveIntegerField(default=30)
    retention_days = models.PositiveIntegerField(default=90)
    updated_at = models.DateTimeField(auto_now=True)
    updated_by = models.ForeignKey(
        settings.AUTH_USER_MODEL, null=True, blank=True, on_delete=models.SET_NULL, related_name="+"
    )

    class Meta:
        constraints = [models.CheckConstraint(condition=Q(id=1), name="field_config_singleton")]

    @classmethod
    def get(cls) -> "FieldConfig":
        obj, _ = cls.objects.get_or_create(pk=1)
        return obj


class WorkSession(models.Model):
    """A declared period of work duty. GPS fixes are only accepted inside one."""

    class EndReason(models.TextChoices):
        MANUAL = "manual", "Ended by the salesman"
        AUTO_TIMEOUT = "auto_timeout", "Closed automatically (left running too long)"
        ADMIN = "admin", "Ended by an administrator"

    salesman = models.ForeignKey(Salesman, on_delete=models.PROTECT, related_name="work_sessions")
    started_at = models.DateTimeField(default=timezone.now)
    ended_at = models.DateTimeField(null=True, blank=True)
    end_reason = models.CharField(max_length=14, choices=EndReason.choices, blank=True)
    ended_by = models.ForeignKey(
        settings.AUTH_USER_MODEL, null=True, blank=True, on_delete=models.SET_NULL, related_name="+"
    )
    consent_version = models.CharField(max_length=32)

    # Latest accepted fix, denormalised so the live map is one cheap query. It only ever moves forward in
    # captured time, so syncing an old offline backlog can never make a position look fresher than it is.
    last_lat = models.DecimalField(max_digits=9, decimal_places=6, null=True, blank=True)
    last_lng = models.DecimalField(max_digits=9, decimal_places=6, null=True, blank=True)
    last_accuracy_m = models.FloatField(null=True, blank=True)
    last_fix_at = models.DateTimeField(null=True, blank=True)
    last_contact_at = models.DateTimeField(null=True, blank=True)  # last time the device reached the server
    ping_count = models.PositiveIntegerField(default=0)

    class Meta:
        indexes = [models.Index(fields=["salesman", "-started_at"])]
        constraints = [
            models.UniqueConstraint(
                fields=["salesman"], condition=Q(ended_at__isnull=True), name="one_active_session_per_salesman"
            ),
            models.CheckConstraint(
                condition=Q(ended_at__isnull=True) | Q(ended_at__gte=F("started_at")), name="session_ends_after_start"
            ),
        ]

    @property
    def is_active(self) -> bool:
        return self.ended_at is None


class LocationPing(models.Model):
    """One accepted GPS fix. ``captured_at`` is the server-validated capture time, never the raw device clock."""

    session = models.ForeignKey(WorkSession, on_delete=models.CASCADE, related_name="pings")
    salesman = models.ForeignKey(Salesman, on_delete=models.PROTECT, related_name="+")
    latitude = models.DecimalField(max_digits=9, decimal_places=6)
    longitude = models.DecimalField(max_digits=9, decimal_places=6)
    accuracy_m = models.FloatField()
    captured_at = models.DateTimeField()
    device_captured_at = models.DateTimeField()  # as reported, kept so a clock correction is auditable
    clock_skew_s = models.IntegerField(default=0)  # seconds added to the device time (0 = trusted as sent)
    received_at = models.DateTimeField(default=timezone.now)
    # Client-generated, so an offline retry never stores the same fix twice.
    client_point_id = models.UUIDField(null=True, blank=True)

    class Meta:
        indexes = [
            models.Index(fields=["salesman", "-captured_at"]),
            models.Index(fields=["session", "captured_at"]),
            models.Index(fields=["captured_at"]),  # retention purge
        ]
        constraints = [
            models.UniqueConstraint(
                fields=["session", "client_point_id"],
                condition=Q(client_point_id__isnull=False),
                name="uniq_ping_client_point",
            ),
            models.CheckConstraint(condition=Q(accuracy_m__gte=0), name="ping_accuracy_non_negative"),
        ]


class FieldAuditLog(models.Model):
    """Who did what with location data. Kept longer than the GPS points themselves."""

    class Action(models.TextChoices):
        SESSION_START = "session_start"
        SESSION_END = "session_end"
        SESSION_FORCE_END = "session_force_end"
        MAP_VIEW = "map_view"
        TRACK_VIEW = "track_view"
        REVERSE_SEARCH = "reverse_search"
        DEALER_LOCATION_SET = "dealer_location_set"
        DEALER_LOCATION_VERIFY = "dealer_location_verify"
        CONFIG_CHANGE = "config_change"
        PURGE = "purge"
        BEAT_SAVE = "beat_save"
        CHECKIN_OVERRIDE = "checkin_override"

    actor = models.ForeignKey(
        settings.AUTH_USER_MODEL, null=True, blank=True, on_delete=models.SET_NULL, related_name="+"
    )
    actor_username = models.CharField(max_length=150, blank=True)  # survives deletion of the user
    action = models.CharField(max_length=24, choices=Action.choices)
    salesman = models.ForeignKey(Salesman, null=True, blank=True, on_delete=models.SET_NULL, related_name="+")
    dealer_id = models.IntegerField(null=True, blank=True)  # plain id: the log outlives the dealer
    detail = models.JSONField(default=dict, blank=True)
    created_at = models.DateTimeField(default=timezone.now, db_index=True)

    class Meta:
        ordering = ["-created_at", "-id"]


class BeatPlan(models.Model):
    """A salesman's planned dealer visits for one day. One plan per salesman per date."""

    salesman = models.ForeignKey(Salesman, on_delete=models.CASCADE, related_name="beat_plans")
    date = models.DateField(db_index=True)
    note = models.CharField(max_length=300, blank=True)
    created_by = models.ForeignKey(
        settings.AUTH_USER_MODEL, null=True, blank=True, on_delete=models.SET_NULL, related_name="+"
    )
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        constraints = [models.UniqueConstraint(fields=["salesman", "date"], name="one_beat_plan_per_salesman_day")]


class BeatStop(models.Model):
    plan = models.ForeignKey(BeatPlan, on_delete=models.CASCADE, related_name="stops")
    dealer = models.ForeignKey(Dealer, on_delete=models.PROTECT, related_name="+")
    sequence = models.PositiveSmallIntegerField()
    note = models.CharField(max_length=200, blank=True)
    skipped_at = models.DateTimeField(null=True, blank=True)
    skipped_reason = models.CharField(max_length=200, blank=True)

    class Meta:
        ordering = ["sequence", "id"]
        constraints = [models.UniqueConstraint(fields=["plan", "dealer"], name="one_stop_per_dealer_per_plan")]


class DealerCheckIn(models.Model):
    """A GPS-verified visit in progress or finished. The business record (orders, follow-ups, notes) is the
    existing ``visits.Visit`` created at check-out; this row holds the verification evidence around it."""

    class Geofence(models.TextChoices):
        INSIDE = "inside", "Inside the geofence"
        OUTSIDE = "outside", "Outside the geofence"
        LOW_ACCURACY = "low_accuracy", "GPS too imprecise to verify"
        NO_DEALER_LOCATION = "no_dealer_location", "Dealer has no location on file"

    class Outcome(models.TextChoices):
        ORDER_TAKEN = "order_taken", "Order taken"
        INTERESTED = "interested", "Interested"
        CALL_AGAIN = "call_again", "Call again"
        SEND_QUOTATION = "send_quotation", "Send quotation"
        NO_ANSWER = "no_answer", "Dealer not available"
        NOT_INTERESTED = "not_interested", "Not interested"

    salesman = models.ForeignKey(Salesman, on_delete=models.PROTECT, related_name="checkins")
    dealer = models.ForeignKey(Dealer, on_delete=models.PROTECT, related_name="checkins")
    session = models.ForeignKey(WorkSession, on_delete=models.PROTECT, related_name="checkins")
    stop = models.ForeignKey(BeatStop, null=True, blank=True, on_delete=models.SET_NULL, related_name="checkins")
    visit = models.OneToOneField("visits.Visit", null=True, blank=True, on_delete=models.SET_NULL, related_name="checkin")

    checked_in_at = models.DateTimeField()  # server time
    in_lat = models.DecimalField(max_digits=9, decimal_places=6)
    in_lng = models.DecimalField(max_digits=9, decimal_places=6)
    in_accuracy_m = models.FloatField()
    in_distance_m = models.IntegerField(null=True, blank=True)
    in_geofence = models.CharField(max_length=20, choices=Geofence.choices)
    in_radius_m = models.PositiveIntegerField()
    in_dealer_verified = models.BooleanField(default=False)  # was the dealer's own location verified at the time?
    in_override_reason = models.CharField(max_length=300, blank=True)

    checked_out_at = models.DateTimeField(null=True, blank=True)
    out_lat = models.DecimalField(max_digits=9, decimal_places=6, null=True, blank=True)
    out_lng = models.DecimalField(max_digits=9, decimal_places=6, null=True, blank=True)
    out_accuracy_m = models.FloatField(null=True, blank=True)
    out_distance_m = models.IntegerField(null=True, blank=True)
    out_geofence = models.CharField(max_length=20, choices=Geofence.choices, blank=True)
    out_override_reason = models.CharField(max_length=300, blank=True)

    outcome = models.CharField(max_length=16, choices=Outcome.choices, blank=True)
    notes = models.TextField(blank=True)
    client_request_id = models.UUIDField(null=True, blank=True)  # check-in retry key
    checkout_request_id = models.UUIDField(null=True, blank=True)  # check-out retry key

    class Meta:
        indexes = [
            models.Index(fields=["salesman", "-checked_in_at"]),
            models.Index(fields=["dealer", "-checked_in_at"]),
        ]
        constraints = [
            models.UniqueConstraint(fields=["salesman"], condition=Q(checked_out_at__isnull=True), name="one_open_checkin_per_salesman"),
            models.UniqueConstraint(fields=["salesman", "client_request_id"], condition=Q(client_request_id__isnull=False), name="uniq_checkin_request"),
            models.CheckConstraint(condition=Q(checked_out_at__isnull=True) | Q(checked_out_at__gte=F("checked_in_at")), name="checkout_after_checkin"),
        ]

    @property
    def flagged(self) -> bool:
        return (self.in_geofence != self.Geofence.INSIDE) or (bool(self.out_geofence) and self.out_geofence != self.Geofence.INSIDE)
