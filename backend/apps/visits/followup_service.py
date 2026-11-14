from datetime import timedelta

from django.db import transaction
from django.db.models import F, Min
from django.utils import timezone
from rest_framework.exceptions import NotFound, ValidationError

from apps.dealers.access import accessible_dealers

from .models import Followup
from .services import get_salesman
from .timing import check_time_not_past


def own_followups(user):
    """A salesman's own follow-ups, limited to dealers they can still access."""
    salesman = get_salesman(user)
    return Followup.objects.filter(salesman=salesman, dealer__in=accessible_dealers(user))


def order_by_due(qs, newest_first=False):
    """Soonest first by day, then by time of day; follow-ups with no time sort after timed ones on the same day."""
    day = "-due_date" if newest_first else "due_date"
    return qs.order_by(day, F("due_time").desc(nulls_last=True) if newest_first else F("due_time").asc(nulls_last=True), "id")


def create_followup(user, data) -> Followup:
    """A reminder for a dealer the salesman can access. One transaction; an identical pending reminder is refused."""
    salesman = get_salesman(user)
    with transaction.atomic():
        # Inaccessible and nonexistent dealers are indistinguishable.
        dealer = accessible_dealers(user).select_for_update().filter(pk=data["dealer_id"]).first()
        if dealer is None:
            raise NotFound("Dealer not found")
        same = Followup.objects.filter(
            salesman=salesman, dealer=dealer, status=Followup.Status.PENDING,
            due_date=data["due_date"], due_time=data.get("due_time"),
        )
        if same.exists():
            raise ValidationError({"detail": "You already have a follow-up for this dealer at that date and time"})
        f = Followup.objects.create(
            dealer=dealer, salesman=salesman, due_date=data["due_date"], due_time=data.get("due_time"),
            priority=data.get("priority", Followup.Priority.MEDIUM), notes=data.get("notes", "").strip(),
        )
        soonest = Followup.objects.filter(dealer=dealer, status=Followup.Status.PENDING).aggregate(d=Min("due_date"))["d"]
        dealer.next_followup_at = soonest
        dealer.save(update_fields=["next_followup_at"])
        return f


def tab_filter(qs, tab, today):
    pending = qs.filter(status=Followup.Status.PENDING)
    return {
        "pending": pending,
        "due_today": pending.filter(due_date=today),
        "overdue": pending.filter(due_date__lt=today),
        "completed": qs.filter(status=Followup.Status.COMPLETED),
    }[tab]


def apply_action(user, followup_id, action, data):
    """complete / reschedule / cancel a pending follow-up the salesman owns."""
    with transaction.atomic():
        f = own_followups(user).select_for_update().select_related("dealer").filter(pk=followup_id).first()
        if f is None:
            raise NotFound("Follow-up not found")
        if f.status != Followup.Status.PENDING:
            raise ValidationError({"detail": f"This follow-up is already {f.status}"})

        notes = data.get("notes")
        if notes:
            f.notes = notes
        if action == "complete":
            f.status = Followup.Status.COMPLETED
            if data.get("outcome"):
                f.outcome = data["outcome"]
        elif action == "cancel":
            f.status = Followup.Status.CANCELLED
        else:
            today = timezone.localdate()
            if data["due_date"] < today:
                raise ValidationError({"due_date": "Choose today or a future date"})
            if data["due_date"] > today + timedelta(days=365):
                raise ValidationError({"due_date": "Choose a date within the next year"})
            f.due_date = data["due_date"]
            if "due_time" in data:  # absent keeps the old time untouched; an explicit null clears it
                f.due_time = data["due_time"]
                check_time_not_past(f.due_date, f.due_time)
            if data.get("priority"):
                f.priority = data["priority"]
        f.save()
        return f
