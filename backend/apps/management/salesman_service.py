from datetime import timedelta

from django.contrib.auth.password_validation import validate_password
from django.core.exceptions import ValidationError as DjangoValidationError
from django.db import IntegrityError, transaction
from django.db.models import Count, Max, Q
from django.utils import timezone
from rest_framework.exceptions import NotFound, ValidationError

from apps.accounts.models import Role, Salesman, SalesmanTerritory, User
from apps.dealers.models import Dealer, DealerAccessGrant, DealerOwnershipHistory
from apps.dealers.services import transfer_ownership
from apps.visits.models import Followup, Visit
from apps.visits.services import normalize_phone

MAX_ASSIGN = 200
PROFILE_FIELDS = ("first_name", "last_name", "email")
TARGET_FIELDS = ("daily_visit_target", "monthly_visit_target", "monthly_order_target")


def get_salesman_or_404(pk) -> Salesman:
    s = Salesman.objects.select_related("user").filter(pk=pk).first()
    if s is None:
        raise NotFound("Salesman not found")
    return s


def _check_password(password, user=None):
    try:
        validate_password(password, user)
    except DjangoValidationError as e:
        raise ValidationError({"password": list(e.messages)})


def _check_phone(raw, exclude_pk=None) -> str:
    phone = normalize_phone(raw)
    if len(phone) != 10:
        raise ValidationError({"phone_number": "Enter a valid 10-digit mobile number"})
    clash = Salesman.objects.filter(phone_number=phone)
    if exclude_pk:
        clash = clash.exclude(pk=exclude_pk)
    if clash.exists():
        raise ValidationError({"phone_number": "Another salesman already uses this phone number"})
    return phone


@transaction.atomic
def create_salesman(data) -> Salesman:
    """Provisions the login account and the salesman profile together."""
    if User.objects.filter(username__iexact=data["username"]).exists():
        raise ValidationError({"username": "This username is taken"})
    phone = _check_phone(data["phone_number"])
    _check_password(data["password"])
    try:
        user = User.objects.create_user(
            username=data["username"], password=data["password"], role=Role.SALESMAN,
            first_name=data.get("first_name", ""), last_name=data.get("last_name", ""), email=data.get("email", ""),
        )
        salesman = Salesman.objects.create(
            user=user, phone_number=phone, **{f: data[f] for f in TARGET_FIELDS if f in data}
        )
    except IntegrityError:
        raise ValidationError({"detail": "A salesman with these details already exists"})
    return salesman


@transaction.atomic
def update_salesman(salesman: Salesman, data) -> Salesman:
    user = salesman.user
    for f in PROFILE_FIELDS:
        if f in data:
            setattr(user, f, data[f])
    if "phone_number" in data:
        salesman.phone_number = _check_phone(data["phone_number"], exclude_pk=salesman.pk)
    for f in TARGET_FIELDS:
        if f in data:
            setattr(salesman, f, data[f])
    if "is_active" in data:
        salesman.is_active = data["is_active"]
        user.is_active = data["is_active"]  # an inactive salesman can no longer sign in
    user.save()
    salesman.save()
    return salesman


def reset_password(salesman: Salesman, password: str):
    _check_password(password, salesman.user)
    salesman.user.set_password(password)
    salesman.user.save(update_fields=["password"])


@transaction.atomic
def set_territories(salesman: Salesman, rows) -> list[SalesmanTerritory]:
    """Replaces the planning territories. Never touches dealer access."""
    seen, clean = set(), []
    for r in rows:
        state, city = r["state"].strip(), r.get("city", "").strip()
        key = (state.lower(), city.lower())
        if key not in seen:
            seen.add(key)
            clean.append((state, city))
    salesman.territories.all().delete()
    return SalesmanTerritory.objects.bulk_create(SalesmanTerritory(salesman=salesman, state=s, city=c) for s, c in clean)


@transaction.atomic
def assign_dealers(salesman: Salesman, dealer_ids, actor, reason="") -> dict:
    """Assigns or transfers dealers to this salesman. All-or-nothing."""
    ids = list(dict.fromkeys(dealer_ids))
    if len(ids) > MAX_ASSIGN:
        raise ValidationError({"dealer_ids": f"Select at most {MAX_ASSIGN} dealers at a time"})
    if not salesman.is_active:
        raise ValidationError({"detail": "Activate this salesman before assigning dealers"})
    found = set(Dealer.objects.filter(pk__in=ids).values_list("pk", flat=True))
    if missing := [i for i in ids if i not in found]:
        raise ValidationError({"dealer_ids": f"Unknown dealers: {missing}"})
    already = set(
        DealerOwnershipHistory.objects.filter(dealer_id__in=ids, salesman=salesman, ended_at__isnull=True).values_list("dealer_id", flat=True)
    )
    moved = [i for i in ids if i not in already]
    for dealer_id in moved:
        transfer_ownership(dealer_id, salesman.id, actor, reason)
    return {"assigned": len(moved), "already_owned": len(already)}


@transaction.atomic
def offboard(salesman: Salesman, actor, transfer_to_id=None, reason="") -> dict:
    """Deactivates the salesman, blocks login, and hands over or releases their dealers."""
    if transfer_to_id is not None and int(transfer_to_id) == salesman.id:
        raise ValidationError({"transfer_to": "Choose a different salesman"})
    now = timezone.now()
    owned = list(DealerOwnershipHistory.objects.filter(salesman=salesman, ended_at__isnull=True).values_list("dealer_id", flat=True))
    reason = reason.strip() or "Offboarding"

    if transfer_to_id is not None:
        for dealer_id in owned:
            transfer_ownership(dealer_id, transfer_to_id, actor, reason)
        reassigned = Followup.objects.filter(salesman=salesman, status=Followup.Status.PENDING, dealer_id__in=owned).update(salesman_id=transfer_to_id)
    else:
        DealerOwnershipHistory.objects.filter(dealer_id__in=owned, salesman=salesman, ended_at__isnull=True).update(ended_at=now)
        Dealer.objects.filter(pk__in=owned, primary_salesman=salesman).update(primary_salesman=None)
        reassigned = 0
    revoked = DealerAccessGrant.objects.filter(salesman=salesman, revoked_at__isnull=True).update(revoked_at=now, revoked_by=actor)

    salesman.is_active = False
    salesman.save(update_fields=["is_active"])
    salesman.user.is_active = False
    salesman.user.save(update_fields=["is_active"])
    return {"dealers_moved": len(owned), "dealers_released": 0 if transfer_to_id is not None else len(owned),
            "followups_reassigned": reassigned, "grants_revoked": revoked}


@transaction.atomic
def delete_salesman(salesman: Salesman):
    """Only for accounts created by mistake. Anyone with history must be deactivated instead."""
    if (
        Visit.objects.filter(salesman=salesman).exists()
        or Followup.objects.filter(salesman=salesman).exists()
        or DealerOwnershipHistory.objects.filter(salesman=salesman).exists()
    ):
        raise ValidationError({"detail": "This salesman has visits, follow-ups or dealer history. Deactivate or offboard instead."})
    user = salesman.user
    salesman.delete()
    user.delete()


def performance(salesman: Salesman) -> dict:
    today = timezone.localdate()
    month_start = today.replace(day=1)
    visits = Visit.objects.filter(salesman=salesman)
    month = visits.filter(visited_at__date__gte=month_start)
    agg = visits.aggregate(
        today=Count("id", filter=Q(visited_at__date=today), distinct=True),
        month=Count("id", filter=Q(visited_at__date__gte=month_start), distinct=True),
        month_orders=Count("id", filter=Q(visited_at__date__gte=month_start, order_items__isnull=False), distinct=True),
        last_visit=Max("visited_at"),
    )
    fu = Followup.objects.filter(salesman=salesman).aggregate(
        pending=Count("id", filter=Q(status="pending")),
        overdue=Count("id", filter=Q(status="pending", due_date__lt=today)),
        completed_month=Count("id", filter=Q(status="completed", created_at__date__gte=month_start)),
    )
    owned = DealerOwnershipHistory.objects.filter(salesman=salesman, ended_at__isnull=True).count()
    new_dealers = month.values("dealer").filter(dealer__created_at__date__gte=month_start).distinct().count()

    def pct(done, target):
        return round(min(done / target, 9.99) * 100) if target else None

    return {
        "today": {"visits": agg["today"], "target": salesman.daily_visit_target, "percent": pct(agg["today"], salesman.daily_visit_target)},
        "month": {
            "visits": agg["month"], "visit_target": salesman.monthly_visit_target, "visit_percent": pct(agg["month"], salesman.monthly_visit_target),
            "orders": agg["month_orders"], "order_target": salesman.monthly_order_target, "order_percent": pct(agg["month_orders"], salesman.monthly_order_target),
            "new_dealers": new_dealers,
        },
        "dealers_owned": owned,
        "followups": {"pending": fu["pending"], "overdue": fu["overdue"], "completed_this_month": fu["completed_month"]},
        "last_visit_at": agg["last_visit"],
        "days_since_last_visit": (today - timezone.localtime(agg["last_visit"]).date()).days if agg["last_visit"] else None,
    }
