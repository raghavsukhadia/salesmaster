from django.db import IntegrityError, transaction
from django.utils import timezone
from rest_framework.exceptions import NotFound, ValidationError

from apps.accounts.models import Salesman

from .models import Dealer, DealerAccessGrant, DealerOwnershipHistory


def current_owner(dealer):
    return dealer.ownerships.filter(ended_at__isnull=True).select_related("salesman__user").first()


def is_current_owner(user, dealer) -> bool:
    """True only for the salesman who owns the dealer right now (an access grant does not count)."""
    owner = current_owner(dealer)
    return bool(owner and owner.salesman.user_id == user.id)


def _active_salesman(salesman_id) -> Salesman:
    salesman = Salesman.objects.filter(pk=salesman_id, is_active=True).select_related("user").first()
    if salesman is None:
        raise ValidationError({"salesman_id": "Choose an active salesman"})
    return salesman


@transaction.atomic
def transfer_ownership(dealer_id, to_salesman_id, actor, reason="") -> DealerOwnershipHistory:
    """Ends the current ownership row and opens a new one. Ownership history stays the authority."""
    dealer = Dealer.objects.select_for_update().filter(pk=dealer_id).first()
    if dealer is None:
        raise NotFound("Dealer not found")
    salesman = _active_salesman(to_salesman_id)

    current = dealer.ownerships.select_for_update().filter(ended_at__isnull=True).first()
    if current and current.salesman_id == salesman.id:
        raise ValidationError({"salesman_id": "This salesman already owns the dealer"})

    now = timezone.now()
    if current:
        current.ended_at = now
        current.save(update_fields=["ended_at"])
    new = DealerOwnershipHistory.objects.create(
        dealer=dealer, salesman=salesman, reason=reason.strip(), changed_by=actor
    )
    # An owner never needs a separate grant, so retire a redundant one.
    DealerAccessGrant.objects.filter(dealer=dealer, salesman=salesman, revoked_at__isnull=True).update(
        revoked_at=now, revoked_by=actor
    )
    dealer.primary_salesman = salesman
    dealer.save(update_fields=["primary_salesman"])
    return new


@transaction.atomic
def add_grant(dealer_id, salesman_id, actor) -> DealerAccessGrant:
    dealer = Dealer.objects.filter(pk=dealer_id).first()
    if dealer is None:
        raise NotFound("Dealer not found")
    salesman = _active_salesman(salesman_id)
    owner = current_owner(dealer)
    if owner and owner.salesman_id == salesman.id:
        raise ValidationError({"salesman_id": "This salesman already owns the dealer"})
    # An expired (not revoked) grant would otherwise block a fresh one via the unique constraint.
    today = timezone.localdate()
    DealerAccessGrant.objects.filter(
        dealer=dealer, salesman=salesman, revoked_at__isnull=True, ends_on__lt=today
    ).update(revoked_at=timezone.now(), revoked_by=actor)
    if DealerAccessGrant.objects.filter(dealer=dealer, salesman=salesman, revoked_at__isnull=True).exists():
        raise ValidationError({"salesman_id": "This salesman already has access"})
    try:
        with transaction.atomic():
            return DealerAccessGrant.objects.create(dealer=dealer, salesman=salesman, created_by=actor)
    except IntegrityError:
        raise ValidationError({"salesman_id": "This salesman already has access"})


@transaction.atomic
def revoke_grant(dealer_id, grant_id, actor) -> DealerAccessGrant:
    grant = (
        DealerAccessGrant.objects.select_for_update()
        .filter(pk=grant_id, dealer_id=dealer_id, revoked_at__isnull=True)
        .first()
    )
    if grant is None:
        raise NotFound("Access grant not found")
    grant.revoked_at = timezone.now()
    grant.revoked_by = actor
    grant.save(update_fields=["revoked_at", "revoked_by"])
    return grant
