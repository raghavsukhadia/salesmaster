from django.conf import settings
from django.db import models
from django.db.models import Q

from apps.accounts.models import Salesman
from apps.dealers.phone import normalize_phone


class Distributor(models.Model):
    name = models.CharField(max_length=200)
    city = models.CharField(max_length=80, blank=True)
    state = models.CharField(max_length=80, blank=True)
    is_active = models.BooleanField(default=True)

    def __str__(self):
        return self.name


class DealerStatus(models.Model):
    """Configurable statuses (Prospect/New/Active/Inactive/Converted/Lost)."""

    name = models.CharField(max_length=40, unique=True)
    sort_order = models.PositiveSmallIntegerField(default=0)

    class Meta:
        ordering = ["sort_order", "name"]
        verbose_name_plural = "dealer statuses"

    def __str__(self):
        return self.name


class Dealer(models.Model):
    name = models.CharField(max_length=200)
    shop_name = models.CharField(max_length=200, blank=True)
    phone = models.CharField(max_length=20, blank=True, db_index=True)
    whatsapp = models.CharField(max_length=20, blank=True, db_index=True)
    address = models.TextField(blank=True)
    city = models.CharField(max_length=80, blank=True)
    state = models.CharField(max_length=80, blank=True)
    pincode = models.CharField(max_length=10, blank=True)
    latitude = models.DecimalField(max_digits=9, decimal_places=6, null=True, blank=True)
    longitude = models.DecimalField(max_digits=9, decimal_places=6, null=True, blank=True)
    # Location master. Coordinates that predate verification stay as they are but are "unverified".
    class LocationSource(models.TextChoices):
        MANUAL = "manual", "Entered manually"
        MAP_PIN = "map_pin", "Placed on map"
        GEOCODED = "geocoded", "Geocoded from address"
        GPS_CHECKIN = "gps_checkin", "Captured at the shop (GPS)"
        IMPORT = "import", "Imported"

    location_source = models.CharField(max_length=12, choices=LocationSource.choices, blank=True)
    location_accuracy_m = models.FloatField(null=True, blank=True)
    location_verified_at = models.DateTimeField(null=True, blank=True)
    location_verified_by = models.ForeignKey(
        settings.AUTH_USER_MODEL, null=True, blank=True, on_delete=models.SET_NULL, related_name="+"
    )
    # Per-dealer geofence override (metres) for check-in/out; NULL = use the global default.
    geofence_radius_m = models.PositiveIntegerField(null=True, blank=True)
    gst_number = models.CharField(max_length=15, blank=True, db_index=True)
    distributor = models.ForeignKey(Distributor, null=True, blank=True, on_delete=models.SET_NULL)
    status = models.ForeignKey(DealerStatus, null=True, blank=True, on_delete=models.SET_NULL)
    last_visit_at = models.DateTimeField(null=True, blank=True)
    is_archived = models.BooleanField(default=False)
    next_followup_at = models.DateField(null=True, blank=True)
    # Legacy reporting column only. DealerOwnershipHistory is authoritative.
    primary_salesman = models.ForeignKey(
        Salesman, null=True, blank=True, on_delete=models.SET_NULL, related_name="+"
    )
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        indexes = [
            models.Index(fields=["state", "city"]),
            # Nearby search: the bounding-box prefilter range-scans this before the exact distance check.
            models.Index(fields=["latitude", "longitude"], name="dealer_lat_lng_idx"),
        ]
        constraints = [
            # Phones are stored normalised (see save()); blank means "no phone" and may repeat.
            models.UniqueConstraint(
                fields=["phone"], condition=~Q(phone=""), name="dealer_phone_unique_when_set"
            ),
        ]

    def save(self, *args, **kwargs):
        self.phone = normalize_phone(self.phone)
        self.whatsapp = normalize_phone(self.whatsapp)
        super().save(*args, **kwargs)

    def __str__(self):
        return self.name


class DealerContact(models.Model):
    dealer = models.ForeignKey(Dealer, on_delete=models.CASCADE, related_name="contacts")
    name = models.CharField(max_length=120)
    designation = models.CharField(max_length=80, blank=True)
    phone = models.CharField(max_length=20, blank=True)
    whatsapp = models.CharField(max_length=20, blank=True)
    email = models.EmailField(blank=True)


class DealerOwnershipHistory(models.Model):
    """Authoritative record of who is responsible for a dealer. ended_at NULL = current."""

    dealer = models.ForeignKey(Dealer, on_delete=models.CASCADE, related_name="ownerships")
    salesman = models.ForeignKey(Salesman, on_delete=models.PROTECT, related_name="ownerships")
    started_at = models.DateTimeField(auto_now_add=True)
    ended_at = models.DateTimeField(null=True, blank=True)
    reason = models.CharField(max_length=200, blank=True)
    changed_by = models.ForeignKey(
        settings.AUTH_USER_MODEL, null=True, blank=True, on_delete=models.SET_NULL, related_name="+"
    )

    class Meta:
        constraints = [
            models.UniqueConstraint(
                fields=["dealer"], condition=Q(ended_at__isnull=True), name="one_current_owner_per_dealer"
            )
        ]


class DealerAccessGrant(models.Model):
    """Access separate from ownership. Per dealer, or by owner/state/city scope."""

    salesman = models.ForeignKey(Salesman, on_delete=models.CASCADE, related_name="access_grants")
    dealer = models.ForeignKey(Dealer, null=True, blank=True, on_delete=models.CASCADE)
    owner = models.ForeignKey(Salesman, null=True, blank=True, on_delete=models.CASCADE, related_name="+")
    state = models.CharField(max_length=80, blank=True)
    city = models.CharField(max_length=80, blank=True)
    class AccessType(models.TextChoices):
        SHARED = "shared", "Shared Access"
        TEMPORARY = "temporary", "Temporary Coverage"

    access_type = models.CharField(max_length=10, choices=AccessType.choices, default=AccessType.SHARED)
    # Inclusive window. NULL start = effective immediately, NULL end = no expiry.
    starts_on = models.DateField(null=True, blank=True)
    ends_on = models.DateField(null=True, blank=True)
    created_at = models.DateTimeField(auto_now_add=True)
    revoked_at = models.DateTimeField(null=True, blank=True)
    created_by = models.ForeignKey(
        settings.AUTH_USER_MODEL, null=True, blank=True, on_delete=models.SET_NULL, related_name="+"
    )
    revoked_by = models.ForeignKey(
        settings.AUTH_USER_MODEL, null=True, blank=True, on_delete=models.SET_NULL, related_name="+"
    )

    class Meta:
        constraints = [
            models.CheckConstraint(
                condition=Q(dealer__isnull=False) | Q(owner__isnull=False) | ~Q(state="") | ~Q(city=""),
                name="grant_has_scope",
            ),
            models.UniqueConstraint(
                fields=["salesman", "dealer"],
                condition=Q(revoked_at__isnull=True, dealer__isnull=False),
                name="one_active_grant_per_dealer_salesman",
            ),
        ]
