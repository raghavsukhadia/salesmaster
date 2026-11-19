from datetime import timedelta
from decimal import Decimal

from django.db.models import Count, Exists, OuterRef, Q
from django.utils import timezone
from rest_framework.exceptions import NotFound, ValidationError
from rest_framework.response import Response
from rest_framework.views import APIView

from apps.accounts.permissions import IsSalesman
from apps.dealers.access import accessible_dealers
from apps.dealers.services import is_current_owner
from apps.management.views import PAGE_SIZE, followup_state
from apps.reports.ranges import parse_day

from .followup_service import apply_action, create_followup, order_by_due, own_followups, tab_filter
from .models import Followup, Visit, VisitOrderItem
from .serializers import FollowupActionSerializer, FollowupCreateSerializer
from .services import get_salesman

TABS = ("pending", "due_today", "overdue", "completed")


def page_number(request) -> int:
    try:
        return max(1, int(request.query_params.get("page", 1)))
    except ValueError:
        return 1


def dealer_brief(d):
    return {"id": d.id, "name": d.name, "phone": d.phone, "city": d.city}


def hhmm(t):
    return t.strftime("%H:%M") if t else None


def order_total(items) -> float:
    return float(sum((i.quantity * i.unit_price for i in items), Decimal("0")))


def visit_status(v) -> str:
    """Derived, there is no stored visit status: an order beats a pending follow-up, which beats a plain visit."""
    if v.order_items.all():
        return "order"
    if any(f.status == Followup.Status.PENDING for f in v.followups.all()):
        return "followup"
    return "visited"


def followup_row(f, today):
    return {
        "id": f.id, "dealer": dealer_brief(f.dealer), "due_date": f.due_date, "due_time": hhmm(f.due_time), "status": f.status,
        "state": followup_state(f, today), "priority": f.priority, "outcome": f.outcome,
        "action": f.action, "task": f.task, "notes": f.notes, "visit_id": f.visit_id,
    }


def own_visits(user):
    salesman = get_salesman(user)
    return Visit.objects.filter(salesman=salesman, dealer__in=accessible_dealers(user))


def visit_list_row(v):
    pending = next((f for f in v.followups.all() if f.status == Followup.Status.PENDING), None)
    items = list(v.order_items.all())
    return {
        "id": v.id, "visited_at": v.visited_at, "dealer": dealer_brief(v.dealer), "notes": v.notes, "source": v.source,
        "status": visit_status(v), "order_total": order_total(items), "salesman": v.salesman_name,
        "order_preview": [{"name": i.product_name, "quantity": i.quantity, "unit": i.unit} for i in items[:3]],
        "items": len(items), "has_order": bool(items),
        "followup_due": pending.due_date if pending else None,
        "followup_due_time": hhmm(pending.due_time) if pending else None,
    }


class SalesmanVisitListView(APIView):
    permission_classes = [IsSalesman]

    def get(self, request):
        base = own_visits(request.user)
        p = request.query_params
        qs = base.select_related("dealer").prefetch_related("order_items", "followups")

        q = p.get("q", "").strip()
        if q:
            qs = qs.filter(Q(dealer__name__icontains=q) | Q(dealer__phone__icontains=q) | Q(dealer__city__icontains=q) | Q(notes__icontains=q))
        now = timezone.now()
        days = {"today": 0, "7": 7, "30": 30}.get(p.get("range", ""))
        if days == 0:
            qs = qs.filter(visited_at__date=timezone.localdate())
        elif days:
            qs = qs.filter(visited_at__gte=now - timedelta(days=days))
        # Inclusive calendar days in the server's local time zone, same basis as range=today. Either bound may be omitted.
        start = parse_day(p["from"], "from") if p.get("from") else None
        end = parse_day(p["to"], "to") if p.get("to") else None
        if start and end and start > end:
            raise ValidationError({"from": "The start date must not be after the end date"})
        if start:
            qs = qs.filter(visited_at__date__gte=start)
        if end:
            qs = qs.filter(visited_at__date__lte=end)
        if p.get("order") == "yes":
            qs = qs.filter(order_items__isnull=False).distinct()
        elif p.get("order") == "no":
            qs = qs.filter(order_items__isnull=True)
        if p.get("source") in ("web", "whatsapp"):
            qs = qs.filter(source=p["source"])
        # Same rule as visit_status(): an order wins over a pending follow-up, which wins over a plain visit.
        status = p.get("status")
        if status in ("order", "followup", "visited"):
            ordered = Exists(VisitOrderItem.objects.filter(visit=OuterRef("pk")))
            pending = Exists(Followup.objects.filter(visit=OuterRef("pk"), status=Followup.Status.PENDING))
            qs = qs.annotate(_ordered=ordered, _pending=pending)
            qs = {"order": qs.filter(_ordered=True), "followup": qs.filter(_ordered=False, _pending=True), "visited": qs.filter(_ordered=False, _pending=False)}[status]

        qs = qs.order_by("-visited_at", "-id")
        page = page_number(request)
        count = qs.count()
        agg = base.aggregate(
            total=Count("id", distinct=True), orders=Count("id", filter=Q(order_items__isnull=False), distinct=True),
            week=Count("id", filter=Q(visited_at__gte=now - timedelta(days=7)), distinct=True),
        )
        return Response({
            "summary": {"total": agg["total"], "orders": agg["orders"], "last_7_days": agg["week"]},
            "count": count,
            "results": [visit_list_row(v) for v in qs[(page - 1) * PAGE_SIZE : page * PAGE_SIZE]],
        })


from .photos import photos_payload  # noqa: E402


class SalesmanVisitDetailView(APIView):
    permission_classes = [IsSalesman]

    def get(self, request, pk):
        v = own_visits(request.user).select_related("dealer", "salesman__user").prefetch_related("order_items", "interests__product", "followups", "photos").filter(pk=pk).first()
        if v is None:
            raise NotFound("Visit not found")
        today = timezone.localdate()
        d = v.dealer
        num = lambda x: float(x) if x is not None else None  # noqa: E731
        return Response({
            "id": v.id, "visited_at": v.visited_at, "source": v.source, "notes": v.notes, "status": visit_status(v),
            "salesman": v.salesman_name,
            "dealer": {**dealer_brief(d), "shop_name": d.shop_name, "state": d.state, "address": d.address, "pincode": d.pincode,
                       "can_edit": is_current_owner(request.user, d)},
            "location": {"lat": num(v.visit_lat), "lng": num(v.visit_lng), "source": v.location_source, "captured_at": v.location_captured_at},
            "order_items": [
                {"name": i.product_name, "quantity": i.quantity, "unit": i.unit,
                 "unit_price": float(i.unit_price), "line_total": float(i.quantity * i.unit_price)}
                for i in v.order_items.all()
            ],
            "order_total": order_total(v.order_items.all()),
            "interests": [i.product.name for i in v.interests.all()],
            "followups": [followup_row(f, today) for f in v.followups.all()],
            "photos": photos_payload(v),
        })


class SalesmanFollowupListView(APIView):
    permission_classes = [IsSalesman]

    def get(self, request):
        p = request.query_params
        tab = p.get("tab", "pending")
        if tab not in TABS:
            raise ValidationError({"tab": f"Must be one of {', '.join(TABS)}"})
        today = timezone.localdate()
        base = own_followups(request.user)
        qs = tab_filter(base, tab, today).select_related("dealer")
        q = p.get("q", "").strip()
        if q:
            qs = qs.filter(Q(dealer__name__icontains=q) | Q(dealer__phone__icontains=q) | Q(dealer__city__icontains=q) | Q(notes__icontains=q))
        if p.get("priority") in ("low", "medium", "high"):
            qs = qs.filter(priority=p["priority"])
        qs = order_by_due(qs, newest_first=tab == "completed")

        pending = Q(status=Followup.Status.PENDING)
        counts = base.aggregate(
            pending=Count("id", filter=pending), due_today=Count("id", filter=pending & Q(due_date=today)),
            overdue=Count("id", filter=pending & Q(due_date__lt=today)), completed=Count("id", filter=Q(status=Followup.Status.COMPLETED)),
        )
        page = page_number(request)
        return Response({
            "counts": counts, "count": qs.count(),
            "results": [followup_row(f, today) for f in qs[(page - 1) * PAGE_SIZE : page * PAGE_SIZE]],
        })

    def post(self, request):
        s = FollowupCreateSerializer(data=request.data)
        s.is_valid(raise_exception=True)
        f = create_followup(request.user, s.validated_data)
        return Response(followup_row(Followup.objects.select_related("dealer").get(pk=f.pk), timezone.localdate()), status=201)


class SalesmanFollowupSummaryView(APIView):
    """Tiny, cheap counts for the sidebar badge. `attention` is what needs action now: due today plus overdue."""

    permission_classes = [IsSalesman]

    def get(self, request):
        today = timezone.localdate()
        agg = own_followups(request.user).filter(status=Followup.Status.PENDING).aggregate(
            pending=Count("id"), due_today=Count("id", filter=Q(due_date=today)), overdue=Count("id", filter=Q(due_date__lt=today)),
        )
        return Response({**agg, "attention": agg["due_today"] + agg["overdue"]})


class SalesmanFollowupActionView(APIView):
    permission_classes = [IsSalesman]

    def post(self, request, pk, action):
        if action not in ("complete", "reschedule", "cancel"):
            raise NotFound()
        s = FollowupActionSerializer(data=request.data)
        s.is_valid(raise_exception=True)
        if action == "reschedule" and "due_date" not in s.validated_data:
            raise ValidationError({"due_date": "This field is required."})
        f = apply_action(request.user, pk, action, s.validated_data)
        return Response(followup_row(f, timezone.localdate()))
