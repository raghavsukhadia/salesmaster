from django.db.models import Q
from django.utils import timezone

from apps.accounts.models import Salesman

from .models import Dealer, DealerAccessGrant, DealerOwnershipHistory


def effective_grants(qs, today=None):
    """Un-revoked grants whose start/end window includes today (both ends inclusive)."""
    today = today or timezone.localdate()
    return qs.filter(revoked_at__isnull=True).filter(
        Q(starts_on__isnull=True) | Q(starts_on__lte=today), Q(ends_on__isnull=True) | Q(ends_on__gte=today)
    )


def accessible_dealers(user):
    """Dealers the user may see. Ownership history + access grants only; territories never count."""
    if user.is_management:
        return Dealer.objects.all()
    salesman = Salesman.objects.filter(user=user, is_active=True).first()
    if salesman is None:
        return Dealer.objects.none()

    owned = DealerOwnershipHistory.objects.filter(salesman=salesman, ended_at__isnull=True).values("dealer_id")
    grants = effective_grants(DealerAccessGrant.objects.filter(salesman=salesman))

    scope = Q(pk__in=owned) | Q(pk__in=grants.filter(dealer__isnull=False).values("dealer_id"))
    for g in grants.filter(dealer__isnull=True):
        cond = Q()
        if g.owner_id:
            cond &= Q(
                pk__in=DealerOwnershipHistory.objects.filter(
                    salesman_id=g.owner_id, ended_at__isnull=True
                ).values("dealer_id")
            )
        if g.state:
            cond &= Q(state__iexact=g.state)
        if g.city:
            cond &= Q(city__iexact=g.city)
        scope |= cond
    return Dealer.objects.filter(scope)


def can_access_dealer(user, dealer_id) -> bool:
    return accessible_dealers(user).filter(pk=dealer_id).exists()
