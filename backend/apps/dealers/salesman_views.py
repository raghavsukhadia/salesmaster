"""The salesman's dealer book: the areas they cover and the dealers in them. Read-only.

Only dealers the salesman added themselves (access.dealers_added_by) are listed: imported/assigned dealers, shared
dealers and dealers transferred in from another salesman are left out. A self-added dealer that was later transferred
away disappears, because dealers_added_by is still limited to what the salesman can access.
Areas are derived from that same set, plus the planning territories an admin assigned, so a freshly assigned area
shows up even before it holds a dealer. A dealer's order history is served by DealerTabView, with the name of the
salesman who recorded each order.
"""

from collections import Counter

from django.db.models import Count, Q
from rest_framework.response import Response
from rest_framework.views import APIView

from apps.accounts.permissions import IsSalesman
from apps.management.views import paginate
from apps.visits.services import get_salesman

from .access import accessible_dealers, dealers_added_by
from .models import DealerOwnershipHistory

# `?state=` value that means "dealers with no state saved".
NO_STATE = "__none__"


def orders_count():
    """Distinct visits that carry at least one order line."""
    return Count("visits", filter=Q(visits__order_items__isnull=False), distinct=True)


class SalesmanAreasView(APIView):
    permission_classes = [IsSalesman]

    def get(self, request):
        salesman = get_salesman(request.user)
        rows = (
            dealers_added_by(request.user).filter(is_archived=False)
            .values("state", "city")
            .annotate(dealers=Count("id", distinct=True), orders=orders_count())
            .order_by("state", "city")  # stable: when "Pune" and "pune" merge, the same spelling always wins
        )

        areas: dict[str, dict] = {}

        def area(state: str) -> dict:
            state = state.strip()
            key = state.lower()
            if key not in areas:
                areas[key] = {
                    "key": state or NO_STATE, "label": state or "State not set", "state": state,
                    "dealers": 0, "orders": 0, "cities": {},
                }
            return areas[key]

        def city_entry(a: dict, city: str) -> dict:
            city = city.strip()
            return a["cities"].setdefault(city.lower(), {"city": city, "dealers": 0})

        for r in rows:
            a = area(r["state"])
            a["dealers"] += r["dealers"]
            a["orders"] += r["orders"]
            if r["city"].strip():
                city_entry(a, r["city"])["dealers"] += r["dealers"]
        # An assigned territory is listed even while it holds no dealer yet.
        for t in salesman.territories.all():
            a = area(t.state)
            if t.city.strip():
                city_entry(a, t.city)

        result = sorted(areas.values(), key=lambda a: (a["state"] == "", a["state"].lower()))
        for a in result:
            a["cities"] = sorted(a["cities"].values(), key=lambda c: c["city"].lower())
        return Response({"areas": result, "dealers": sum(a["dealers"] for a in result)})


class SalesmanDealerListView(APIView):
    """The dealers this salesman added themselves, with how many orders each already has."""

    permission_classes = [IsSalesman]

    def get(self, request):
        salesman = get_salesman(request.user)
        p = request.query_params
        qs = dealers_added_by(request.user).filter(is_archived=False)

        state = p.get("state", "").strip()
        if state == NO_STATE:
            qs = qs.filter(state="")
        elif state:
            qs = qs.filter(state__iexact=state)
        if city := p.get("city", "").strip():
            qs = qs.filter(city__iexact=city)
        if q := p.get("q", "").strip():
            qs = qs.filter(Q(name__icontains=q) | Q(shop_name__icontains=q) | Q(phone__icontains=q) | Q(city__icontains=q))

        qs = qs.select_related("status").annotate(order_count=orders_count()).order_by("name", "id")
        count, page = paginate(request, qs)
        page = list(page)
        mine = set(
            DealerOwnershipHistory.objects.filter(
                salesman=salesman, ended_at__isnull=True, dealer_id__in=[d.id for d in page]
            ).values_list("dealer_id", flat=True)
        )
        return Response({
            "count": count,
            "results": [{
                "id": d.id, "name": d.name, "shop_name": d.shop_name, "phone": d.phone, "city": d.city, "state": d.state,
                "status": d.status.name if d.status else "", "last_visit_at": d.last_visit_at,
                "orders": d.order_count,
                # False = visible through a shared / temporary access grant rather than owned.
                "mine": d.id in mine,
            } for d in page],
        })


class SalesmanCitiesView(APIView):
    """Cities already saved on the dealers this salesman can see, offered as suggestions when typing a new dealer's city.

    "Nagpur", "nagpur " and "NAGPUR" are one city: the spelling and state used most often win."""

    permission_classes = [IsSalesman]

    def get(self, request):
        rows = (
            accessible_dealers(request.user).filter(is_archived=False).exclude(city="")
            .values("city", "state").annotate(n=Count("id"))
        )
        spellings: dict[str, Counter] = {}
        states: dict[str, Counter] = {}
        for r in rows:
            city = " ".join(r["city"].split())
            if not city:
                continue
            key = city.lower()
            spellings.setdefault(key, Counter())[city] += r["n"]
            if r["state"].strip():
                states.setdefault(key, Counter())[r["state"].strip()] += r["n"]
        # A tie goes to the alphabetically first spelling, so the winner never flips between requests.
        best = lambda c: max(sorted(c), key=c.__getitem__) if c else ""  # noqa: E731
        return Response(sorted(
            ({"city": best(spellings[k]), "state": best(states.get(k, Counter()))} for k in spellings),
            key=lambda r: r["city"].lower(),
        ))
