"""Bulk ownership transfer, ownership cleanup and scoped access grants.

Ownership and access stay separate: transfers go through dealers.services.transfer_ownership (the
authoritative history), grants only ever add visibility and never change ownership.
"""

from django.db import transaction
from django.db.models import Count, Q
from django.utils import timezone
from rest_framework.exceptions import NotFound, ValidationError

from apps.accounts.models import Salesman, SalesmanTerritory
from apps.dealers.access import effective_grants
from apps.dealers.models import Dealer, DealerAccessGrant, DealerOwnershipHistory
from apps.dealers.services import transfer_ownership
from apps.visits.models import Followup, Visit

MODES = ("owner_state", "owner_city", "dealer")
TRANSFER_REASONS = {
    "manual": "Manual transfer",
    "salesman_left": "Salesman left",
    "territory_change": "Territory change",
    "workload": "Workload balancing",
}
PREVIEW_SAMPLE = 10


def _current():
    return DealerOwnershipHistory.objects.filter(ended_at__isnull=True)


def _active_salesman(pk, field) -> Salesman:
    s = Salesman.objects.filter(pk=pk, is_active=True).select_related("user").first() if pk else None
    if s is None:
        raise ValidationError({field: "Choose an active salesman"})
    return s


def resolve_scope(data):
    """Validates a scope and returns (dealer, owner, state, city, dealers queryset)."""
    mode = data.get("mode")
    if mode not in MODES:
        raise ValidationError({"mode": "Choose a scope"})
    if mode == "dealer":
        dealer = Dealer.objects.filter(pk=data.get("dealer_id")).first() if data.get("dealer_id") else None
        if dealer is None:
            raise ValidationError({"dealer_id": "Choose a dealer"})
        return dealer, None, "", "", Dealer.objects.filter(pk=dealer.pk)

    owner = Salesman.objects.filter(pk=data.get("owner_id")).select_related("user").first() if data.get("owner_id") else None
    if owner is None:
        raise ValidationError({"owner_id": "Choose the current owner"})
    state = (data.get("state") or "").strip()
    city = (data.get("city") or "").strip()
    if mode == "owner_state" and not state:
        raise ValidationError({"state": "Choose a state"})
    if mode == "owner_city" and not city:
        raise ValidationError({"city": "Choose a city"})
    if mode == "owner_state":
        city = ""
    qs = Dealer.objects.filter(pk__in=_current().filter(salesman=owner).values("dealer_id"), is_archived=False)
    if state:
        qs = qs.filter(state__iexact=state)
    if city:
        qs = qs.filter(city__iexact=city)
    return None, owner, state, city, qs


def _sample(qs):
    return list(qs.order_by("name").values("id", "name", "city", "state")[:PREVIEW_SAMPLE])


# ---- transfers -------------------------------------------------------------------------------

def _territories_to_move(data, owner, state, city):
    """Planning territories that travel with a whole-state / whole-city handover (never with a single dealer).

    Territories are a label only and grant no access (see SalesmanTerritory), but leaving "Maharashtra" on the
    previous salesman's profile after handing Maharashtra over would contradict the transfer."""
    if owner is None:
        return SalesmanTerritory.objects.none()
    mine = SalesmanTerritory.objects.filter(salesman=owner)
    if data.get("mode") == "owner_state":
        return mine.filter(state__iexact=state)
    return mine.filter(city__iexact=city)


def _transfer_plan(data):
    dealer, owner, state, city, qs = resolve_scope(data)
    to = _active_salesman(data.get("to_salesman_id"), "to_salesman_id")
    if owner and owner.id == to.id:
        raise ValidationError({"to_salesman_id": "The new owner is the current owner"})
    # Dealers the new owner already holds are no-ops rather than errors.
    qs = qs.exclude(pk__in=_current().filter(salesman=to).values("dealer_id"))
    return to, qs, _territories_to_move(data, owner, state, city)


def _move_territories(territories, to) -> int:
    moved = 0
    for t in list(territories):
        if SalesmanTerritory.objects.filter(salesman=to, state__iexact=t.state, city__iexact=t.city).exists():
            t.delete()  # the new owner already has it: just retire the old row
        else:
            t.salesman = to
            t.save(update_fields=["salesman"])
        moved += 1
    return moved


def preview_transfer(data) -> dict:
    to, qs, territories = _transfer_plan(data)
    ids = qs.values("id")
    return {
        "dealers": qs.count(),
        "open_followups": Followup.objects.filter(dealer__in=ids, status=Followup.Status.PENDING).count(),
        # Orders already recorded on these dealers. A transfer never touches them: each keeps the salesman who took it.
        "past_orders": Visit.objects.filter(dealer__in=ids, order_items__isnull=False).distinct().count(),
        "territories": [t.state + (f" / {t.city}" if t.city else "") for t in territories],
        "sample": _sample(qs),
        "new_owner": to.user.get_full_name() or to.user.username,
    }


@transaction.atomic
def execute_transfer(data, actor) -> dict:
    """Moves dealer ownership (and, optionally, open follow-ups) to a new salesman.

    Only ownership changes. Visits and their order lines are never written to, so every past order keeps the
    salesman who recorded it; only orders recorded after the transfer carry the new salesman's name."""
    to, qs, territories = _transfer_plan(data)
    reason = TRANSFER_REASONS.get(data.get("reason") or "manual")
    if reason is None:
        raise ValidationError({"reason": "Unknown reason"})
    ids = list(qs.values_list("id", flat=True))
    if not ids:
        raise ValidationError({"detail": "No dealers to transfer for this selection"})
    for dealer_id in ids:
        transfer_ownership(dealer_id, to.id, actor, reason)
    reassigned = 0
    if data.get("reassign_followups", True):
        reassigned = Followup.objects.filter(
            dealer_id__in=ids, status=Followup.Status.PENDING
        ).exclude(salesman=to).update(salesman=to)
    return {"transferred": len(ids), "followups_reassigned": reassigned, "territories_moved": _move_territories(territories, to)}


def owner_areas(owner_id) -> list[dict]:
    """The states a salesman currently holds dealers in, for the "Transfer Area" picker."""
    owner = Salesman.objects.filter(pk=owner_id).first() if owner_id else None
    if owner is None:
        raise ValidationError({"owner_id": "Choose a salesman"})
    rows = (
        Dealer.objects.filter(pk__in=_current().filter(salesman=owner).values("dealer_id"), is_archived=False)
        .exclude(state="")
        .values("state")
        .annotate(dealers=Count("id", distinct=True), orders=Count("visits", filter=Q(visits__order_items__isnull=False), distinct=True))
        .order_by("state")  # stable: the same spelling always represents a merged state
    )
    merged: dict[str, dict] = {}
    for r in rows:  # "maharashtra" and "Maharashtra" are the same area
        a = merged.setdefault(r["state"].strip().lower(), {"state": r["state"].strip(), "dealers": 0, "orders": 0})
        a["dealers"] += r["dealers"]
        a["orders"] += r["orders"]
    return sorted(merged.values(), key=lambda a: a["state"].lower())


# ---- ownership cleanup -----------------------------------------------------------------------

def _unowned(params):
    qs = Dealer.objects.filter(is_archived=False).exclude(pk__in=_current().values("dealer_id"))
    if params.get("state"):
        qs = qs.filter(state__iexact=params["state"])
    if params.get("city"):
        qs = qs.filter(city__icontains=params["city"])
    if params.get("status"):
        qs = qs.filter(status__name__iexact=params["status"])
    if params.get("q"):
        qs = qs.filter(name__icontains=params["q"].strip())
    return qs


def cleanup_groups(params) -> dict:
    qs = _unowned(params)
    groups = list(qs.values("state", "city").annotate(count=Count("id")).order_by("state", "city")[:300])
    return {
        "total": qs.count(),
        "groups": groups,
        "filters": {
            "states": sorted(set(Dealer.objects.exclude(state="").values_list("state", flat=True))),
            "statuses": list(Dealer.objects.exclude(status=None).values_list("status__name", flat=True).distinct()),
        },
    }


@transaction.atomic
def assign_unowned(data, actor) -> dict:
    to = _active_salesman(data.get("salesman_id"), "salesman_id")
    if "state" not in data or "city" not in data:
        raise ValidationError({"detail": "Choose a state and city group to assign"})
    ids = list(
        _unowned({"state": data["state"], "status": data.get("status"), "q": data.get("q")})
        .filter(city__iexact=data["city"])
        .filter(state__iexact=data["state"])
        .values_list("id", flat=True)
    )
    if not ids:
        raise ValidationError({"detail": "No unassigned dealers left in this group"})
    for dealer_id in ids:
        transfer_ownership(dealer_id, to.id, actor, "Ownership cleanup")
    return {"assigned": len(ids)}


# ---- access grants ---------------------------------------------------------------------------

def _grant_plan(data):
    dealer, owner, state, city, qs = resolve_scope(data)
    grantee = _active_salesman(data.get("salesman_id"), "salesman_id")
    kind = data.get("access_type") or DealerAccessGrant.AccessType.SHARED
    if kind not in DealerAccessGrant.AccessType.values:
        raise ValidationError({"access_type": "Unknown access type"})
    starts, ends = data.get("starts_on"), data.get("ends_on")
    if kind == DealerAccessGrant.AccessType.TEMPORARY and not ends:
        raise ValidationError({"ends_on": "Temporary coverage needs an end date"})
    if starts and ends and ends < starts:
        raise ValidationError({"ends_on": "End date cannot be before the start date"})
    if ends and ends < timezone.localdate():
        raise ValidationError({"ends_on": "End date is already in the past"})
    if owner and owner.id == grantee.id:
        raise ValidationError({"salesman_id": "A salesman cannot be given access to their own dealers"})
    # Owned dealers never need a grant.
    qs = qs.exclude(pk__in=_current().filter(salesman=grantee).values("dealer_id"))
    return dealer, owner, state, city, grantee, kind, starts, ends, qs


def preview_grant(data) -> dict:
    *_, grantee, _kind, _s, _e, qs = _grant_plan(data)
    return {"dealers": qs.count(), "sample": _sample(qs), "grantee": grantee.user.get_full_name() or grantee.user.username}


@transaction.atomic
def create_grant(data, actor) -> DealerAccessGrant:
    dealer, owner, state, city, grantee, kind, starts, ends, qs = _grant_plan(data)
    if dealer:
        if not qs.exists():
            raise ValidationError({"salesman_id": "This salesman already owns the dealer"})
        today = timezone.localdate()
        DealerAccessGrant.objects.filter(
            dealer=dealer, salesman=grantee, revoked_at__isnull=True, ends_on__lt=today
        ).update(revoked_at=timezone.now(), revoked_by=actor)
        if DealerAccessGrant.objects.filter(dealer=dealer, salesman=grantee, revoked_at__isnull=True).exists():
            raise ValidationError({"salesman_id": "This salesman already has access to this dealer"})
        return DealerAccessGrant.objects.create(
            salesman=grantee, dealer=dealer, access_type=kind, starts_on=starts, ends_on=ends, created_by=actor
        )
    if not qs.exists():
        raise ValidationError({"detail": "No dealers match this scope"})
    if DealerAccessGrant.objects.filter(
        salesman=grantee, dealer__isnull=True, owner=owner, state__iexact=state, city__iexact=city, revoked_at__isnull=True,
    ).exists():
        raise ValidationError({"detail": "This salesman already has access to this scope"})
    return DealerAccessGrant.objects.create(
        salesman=grantee, owner=owner, state=state, city=city,
        access_type=kind, starts_on=starts, ends_on=ends, created_by=actor,
    )


def grant_status(g, today) -> str:
    if g.revoked_at:
        return "revoked"
    if g.ends_on and g.ends_on < today:
        return "expired"
    if g.starts_on and g.starts_on > today:
        return "scheduled"
    return "active"


def list_grants(status, page, size):
    today = timezone.localdate()
    qs = DealerAccessGrant.objects.select_related("salesman__user", "owner__user", "dealer")
    if status == "active":
        qs = effective_grants(qs, today)
    elif status == "scheduled":
        qs = qs.filter(revoked_at__isnull=True, starts_on__gt=today)
    elif status == "expired":
        qs = qs.filter(revoked_at__isnull=True, ends_on__lt=today)
    elif status == "revoked":
        qs = qs.filter(revoked_at__isnull=False)
    qs = qs.order_by("-created_at", "-id")
    return qs.count(), list(qs[(page - 1) * size : page * size]), today


@transaction.atomic
def revoke_any_grant(grant_id, actor) -> DealerAccessGrant:
    g = DealerAccessGrant.objects.select_for_update().filter(pk=grant_id, revoked_at__isnull=True).first()
    if g is None:
        raise NotFound("Access grant not found")
    g.revoked_at = timezone.now()
    g.revoked_by = actor
    g.save(update_fields=["revoked_at", "revoked_by"])
    return g
