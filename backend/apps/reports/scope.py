"""Filters and the only place that turns them into querysets.

Rules every report relies on:

* An **order** is a visit that has at least one order line (there is no orders table). Quantities are summed
  from `VisitOrderItem` only, and visits / follow-ups are always aggregated in *separate* queries, never joined to
  each other, so a visit with several lines and several follow-ups cannot multiply anything.
* There is no order status or price in the data: every recorded order counts as a sale and nothing is "revenue".
* Salesmen are forced onto their own visits **and** onto dealers they can still access, the same rule as Visit
  History. Management sees everything. The `salesman` query parameter is ignored for salesmen.
"""
import dataclasses
import re
from dataclasses import dataclass

from django.db.models import CharField, Case, Q, Value, When
from django.db.models.functions import Cast, Concat, Lower
from rest_framework.exceptions import ValidationError

from apps.dealers.access import accessible_dealers
from apps.visits.models import Followup, Product, Visit, VisitOrderItem
from apps.visits.services import get_salesman

from .ranges import DateRange, resolve_range

PRODUCT_KEY_RE = re.compile(r"^(p\d{1,12}|n:.{1,200})$", re.S)
UNIT_RE = re.compile(r"^[A-Za-z ]{1,10}$")

# One identity per product across order lines: the catalogue product when the line is linked to one (so a renamed
# product stays one row), otherwise the free-text name, case-insensitively.
PKEY = Case(
    When(product_id__isnull=False, then=Concat(Value("p"), Cast("product_id", CharField()), output_field=CharField())),
    default=Concat(Value("n:"), Lower("product_name"), output_field=CharField()),
    output_field=CharField(),
)


@dataclass(frozen=True)
class Filters:
    user: object
    management: bool
    range: DateRange
    salesman_id: int | None = None
    dealer_id: int | None = None
    product: str = ""  # a PKEY value: 'p12' or 'n:custom name'
    category: str = ""
    order_id: int | None = None
    unit: str = ""  # an order-line unit such as 'pcs' or 'roll'; quantities in different units must never be added together

    def with_(self, **changes) -> "Filters":
        return dataclasses.replace(self, **changes)

    @property
    def dated(self) -> bool:
        """An explicit Order ID wins over the date range, so looking an order up never comes back empty."""
        return not self.order_id


def _int(params, name):
    raw = params.get(name)
    if raw in (None, ""):
        return None
    if not str(raw).isdigit() or len(str(raw)) > 12:
        raise ValidationError({name: "Must be a number"})
    return int(raw)


def parse_filters(request) -> Filters:
    p = request.query_params
    user = request.user
    product = (p.get("product") or "").strip()
    if product and not PRODUCT_KEY_RE.match(product):
        raise ValidationError({"product": "Unknown product"})
    salesman_id = _int(p, "salesman")
    if not user.is_management:
        salesman_id = get_salesman(user).id  # raises 403 when the login has no active salesman profile
    unit = (p.get("unit") or "").strip()
    if unit and not UNIT_RE.match(unit):
        raise ValidationError({"unit": "Unknown unit"})
    return Filters(
        user=user,
        management=user.is_management,
        range=resolve_range(p.get("preset"), p.get("from"), p.get("to")),
        salesman_id=salesman_id,
        dealer_id=_int(p, "dealer"),
        product=product,
        category=(p.get("category") or "").strip()[:100],
        order_id=_int(p, "order"),
        unit=unit,
    )


def _visit_q(f: Filters, prefix: str = "", *, dated: bool = True) -> Q:
    q = Q()
    if dated and f.dated:
        lo, hi = f.range.bounds()
        if lo:
            q &= Q(**{f"{prefix}visited_at__gte": lo})
        if hi:
            q &= Q(**{f"{prefix}visited_at__lt": hi})
    if f.salesman_id:
        q &= Q(**{f"{prefix}salesman_id": f.salesman_id})
    if not f.management:
        q &= Q(**{f"{prefix}dealer_id__in": accessible_dealers(f.user).values("id")})
    if f.dealer_id:
        q &= Q(**{f"{prefix}dealer_id": f.dealer_id})
    if f.order_id:
        q &= Q(**{f"{prefix}id": f.order_id})
    return q


def product_q(f: Filters) -> Q:
    q = Q()
    if f.product.startswith("p"):
        q &= Q(product_id=int(f.product[1:]))
    elif f.product.startswith("n:"):
        q &= Q(product__isnull=True, product_name__iexact=f.product[2:])
    if f.category:
        q &= Q(product__category__iexact=f.category)
    if f.unit:
        q &= Q(unit__iexact=f.unit)
    return q


def visits(f: Filters, *, dated: bool = True):
    """Visits in scope. Product / category filters do not apply: they only narrow order lines."""
    return Visit.objects.filter(_visit_q(f, dated=dated))


def lines(f: Filters, *, dated: bool = True):
    """Order lines in scope, with every filter applied. The base of every quantity and order figure."""
    return VisitOrderItem.objects.filter(_visit_q(f, "visit__", dated=dated), product_q(f))


def followups(f: Filters, *, dated: bool = True):
    qs = Followup.objects.all()
    if f.salesman_id:
        qs = qs.filter(salesman_id=f.salesman_id)
    if not f.management:
        qs = qs.filter(dealer_id__in=accessible_dealers(f.user).values("id"))
    if f.dealer_id:
        qs = qs.filter(dealer_id=f.dealer_id)
    if dated and f.dated:
        if f.range.start:
            qs = qs.filter(due_date__gte=f.range.start)
        if f.range.end:
            qs = qs.filter(due_date__lte=f.range.end)
    return qs


def product_label(key: str) -> str:
    """Human name for a product key (used in the 'filters applied' line of exports)."""
    if key.startswith("p"):
        p = Product.objects.filter(pk=int(key[1:])).first()
        return p.name if p else "Unknown product"
    return key[2:]
