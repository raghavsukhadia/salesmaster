import uuid

from django.db import models
from django.db.models import Q
from django.db.models.functions import Lower
from django.utils import timezone

from apps.accounts.models import Salesman
from apps.dealers.models import Dealer


class Product(models.Model):
    name = models.CharField(max_length=200)
    category = models.CharField(max_length=100, blank=True)
    description = models.TextField(blank=True)
    is_active = models.BooleanField(default=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        constraints = [
            models.UniqueConstraint(Lower("name"), name="uniq_product_name_ci")
        ]

    def __str__(self):
        return self.name


class Visit(models.Model):
    class Source(models.TextChoices):
        WEB = "web"
        WHATSAPP = "whatsapp"

    salesman = models.ForeignKey(Salesman, on_delete=models.PROTECT, related_name="visits")
    # Historical attribution, independent of subsequent changes to the salesman's profile.
    salesman_name = models.CharField(max_length=310, default="", editable=False)
    dealer = models.ForeignKey(Dealer, on_delete=models.PROTECT, related_name="visits")
    visited_at = models.DateTimeField(db_index=True)
    # Dealer, salesman and visit locations are kept distinct; dealer location lives on Dealer.
    salesman_lat = models.DecimalField(max_digits=9, decimal_places=6, null=True, blank=True)
    salesman_lng = models.DecimalField(max_digits=9, decimal_places=6, null=True, blank=True)
    visit_lat = models.DecimalField(max_digits=9, decimal_places=6, null=True, blank=True)
    visit_lng = models.DecimalField(max_digits=9, decimal_places=6, null=True, blank=True)
    location_source = models.CharField(max_length=30, blank=True)
    location_captured_at = models.DateTimeField(null=True, blank=True)
    notes = models.TextField(blank=True)
    source = models.CharField(max_length=16, choices=Source.choices, default=Source.WEB)
    # Client-generated key so a double-tap or retry never creates a second visit.
    client_request_id = models.UUIDField(null=True, blank=True)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        indexes = [models.Index(fields=["salesman", "-visited_at"])]
        constraints = [
            models.UniqueConstraint(
                fields=["salesman", "client_request_id"],
                condition=Q(client_request_id__isnull=False),
                name="uniq_visit_client_request",
            )
        ]

    def save(self, *args, **kwargs):
        # The salesman on a visit (and so on its order) is whoever recorded it. Handing a dealer or a whole area
        # to someone else moves ownership only; nothing may re-attribute an existing visit afterwards.
        if self._state.adding:
            user = self.salesman.user
            self.salesman_name = user.get_full_name() or user.username
        elif self.pk is not None:
            stored = Visit.objects.filter(pk=self.pk).values("salesman_id", "salesman_name").first()
            if stored is not None:
                if stored["salesman_id"] != self.salesman_id:
                    raise ValueError("A recorded visit cannot be moved to a different salesman")
                if stored["salesman_name"] != self.salesman_name:
                    raise ValueError("A recorded visit's original salesman name cannot be changed")
        super().save(*args, **kwargs)


class VisitOrderItem(models.Model):
    """An order is the set of these rows on a visit. There is no orders table."""

    visit = models.ForeignKey(Visit, on_delete=models.CASCADE, related_name="order_items")
    product_name = models.CharField(max_length=200)
    product = models.ForeignKey(Product, null=True, blank=True, on_delete=models.SET_NULL)
    quantity = models.PositiveIntegerField()
    unit = models.CharField(max_length=10, default="pcs")
    unit_price = models.DecimalField(max_digits=12, decimal_places=2, default=0)

    class Meta:
        constraints = [models.CheckConstraint(condition=Q(quantity__gt=0), name="order_item_qty_positive")]


class VisitProduct(models.Model):
    """Product interest, not order lines."""

    visit = models.ForeignKey(Visit, on_delete=models.CASCADE, related_name="interests")
    product = models.ForeignKey(Product, on_delete=models.CASCADE)

    class Meta:
        constraints = [models.UniqueConstraint(fields=["visit", "product"], name="uniq_visit_product")]


class Followup(models.Model):
    class Status(models.TextChoices):
        PENDING = "pending"
        COMPLETED = "completed"
        CANCELLED = "cancelled"

    class Priority(models.TextChoices):
        LOW = "low"
        MEDIUM = "medium"
        HIGH = "high"

    class Outcome(models.TextChoices):
        INTERESTED = "interested"
        CALL_AGAIN = "call_again"
        SEND_QUOTATION = "send_quotation"
        NO_ANSWER = "no_answer"
        NOT_INTERESTED = "not_interested"

    dealer = models.ForeignKey(Dealer, on_delete=models.CASCADE, related_name="followups")
    salesman = models.ForeignKey(Salesman, on_delete=models.PROTECT, related_name="followups")
    visit = models.ForeignKey(Visit, null=True, blank=True, on_delete=models.SET_NULL, related_name="followups")
    parent = models.ForeignKey("self", null=True, blank=True, on_delete=models.SET_NULL, related_name="children")
    due_date = models.DateField(db_index=True)
    # Optional time of day for the reminder (local time). NULL = "any time that day"; overdue/due-today stay date-based.
    due_time = models.TimeField(null=True, blank=True)
    status = models.CharField(max_length=12, choices=Status.choices, default=Status.PENDING)
    priority = models.CharField(max_length=8, choices=Priority.choices, default=Priority.MEDIUM)
    outcome = models.CharField(max_length=16, choices=Outcome.choices, blank=True)
    notes = models.TextField(blank=True)
    created_at = models.DateTimeField(default=timezone.now)

    class Meta:
        indexes = [models.Index(fields=["salesman", "status", "due_date"])]


def visit_photo_path(instance, filename):
    # The client's filename is never used: it could contain anything.
    return f"visit_photos/{instance.salesman_id}/{uuid.uuid4().hex}.jpg"


class VisitPhoto(models.Model):
    """A photo taken on a visit. Staged with ``visit`` NULL, attached when the visit is saved."""

    class Kind(models.TextChoices):
        CAR = "car", "Car photo"

    salesman = models.ForeignKey(Salesman, on_delete=models.PROTECT, related_name="visit_photos")
    visit = models.ForeignKey(Visit, null=True, blank=True, on_delete=models.CASCADE, related_name="photos")
    kind = models.CharField(max_length=8, choices=Kind.choices, default=Kind.CAR)
    image = models.FileField(upload_to=visit_photo_path)
    width = models.PositiveIntegerField()
    height = models.PositiveIntegerField()
    size_bytes = models.PositiveIntegerField()
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        indexes = [models.Index(fields=["salesman", "visit"]), models.Index(fields=["visit"])]
