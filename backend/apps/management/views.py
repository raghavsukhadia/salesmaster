from datetime import timedelta

from django.db.models import Count, Max, Q
from django.utils import timezone
from rest_framework.response import Response
from rest_framework.views import APIView

from apps.accounts.models import Salesman
from apps.accounts.permissions import IsManagement
from apps.dealers.access import effective_grants
from apps.dealers.models import Dealer, DealerAccessGrant, DealerOwnershipHistory
from apps.visits.models import Followup, Visit

PAGE_SIZE = 25


def person(salesman):
    u = salesman.user
    return u.get_full_name() or u.username


def paginate(request, qs):
    try:
        page = max(1, int(request.query_params.get("page", 1)))
    except ValueError:
        page = 1
    return qs.count(), qs[(page - 1) * PAGE_SIZE : page * PAGE_SIZE]


def followup_state(f, today):
    if f.status == Followup.Status.COMPLETED:
        return "completed"
    if f.status == Followup.Status.CANCELLED:
        return "cancelled"
    if f.due_date < today:
        return "overdue"
    return "due_today" if f.due_date == today else "upcoming"


STALE_VISIT_DAYS = 30


def stale_visit_q(now):
    """Dealers never visited, or not visited for STALE_VISIT_DAYS. One definition for the dashboard count
    and for the Dealers list filter it links to, so the two numbers always agree."""
    return Q(last_visit_at__isnull=True) | Q(last_visit_at__lt=now - timedelta(days=STALE_VISIT_DAYS))


def checkin_point(v):
    """The GPS fix captured when the visit was recorded, or None if the device gave none."""
    if v.visit_lat is None or v.visit_lng is None:
        return None
    return {"lat": float(v.visit_lat), "lng": float(v.visit_lng), "source": v.location_source}


def visit_row(v):
    items = [i.product_name for i in v.order_items.all()]
    fu = next(iter(v.followups.all()), None)
    d = v.dealer
    return {
        "id": v.id,
        "visited_at": v.visited_at,
        "salesman": v.salesman_name,
        "dealer": d.name,
        "phone": d.phone,
        "location": ", ".join(x for x in (d.city, d.state) if x),
        "checkin": checkin_point(v),
        "products": items,
        "has_order": bool(items),
        "followup_due": fu.due_date if fu else None,
    }


class DashboardView(APIView):
    permission_classes = [IsManagement]

    def get(self, request):
        today = timezone.localdate()
        now = timezone.now()
        dealers = Dealer.objects.filter(is_archived=False)
        pending = Followup.objects.filter(status=Followup.Status.PENDING)
        overdue = pending.filter(due_date__lt=today).count()
        owned = DealerOwnershipHistory.objects.filter(ended_at__isnull=True).values("dealer_id")

        activity = (
            Salesman.objects.filter(is_active=True).select_related("user")
            .annotate(
                visits_today=Count("visits", filter=Q(visits__visited_at__date=today), distinct=True),
                orders=Count("visits", filter=Q(visits__visited_at__date=today, visits__order_items__isnull=False), distinct=True),
                due=Count("followups", filter=Q(followups__status="pending", followups__due_date__lte=today), distinct=True),
                last_visit=Max("visits__visited_at"),
            )
            .order_by("user__first_name", "user__username")
        )
        new_by = dict(
            Dealer.objects.filter(created_at__date=today, primary_salesman__isnull=False)
            .values_list("primary_salesman_id").annotate(n=Count("id"))
        )
        recent = Visit.objects.select_related("salesman__user", "dealer").prefetch_related("order_items", "followups").order_by("-visited_at")[:8]
        return Response({
            "kpis": {
                "total_dealers": dealers.count(),
                "visits_today": Visit.objects.filter(visited_at__date=today).count(),
                "active_salesmen": Salesman.objects.filter(is_active=True).count(),
                "new_dealers_today": Dealer.objects.filter(created_at__date=today).count(),
                "pending_followups": pending.count(),
                "overdue_followups": overdue,
            },
            # Yesterday's full-day counts, so a card can show "Yesterday: N" next to today's running total.
            # Only the two metrics that have a real history are included; totals have none.
            "trends": {
                "visits_yesterday": Visit.objects.filter(visited_at__date=today - timedelta(days=1)).count(),
                "new_dealers_yesterday": Dealer.objects.filter(created_at__date=today - timedelta(days=1)).count(),
            },
            "unassigned_dealers": dealers.exclude(pk__in=owned).count(),
            "overdue_followups": overdue,
            "no_recent_visit": dealers.filter(stale_visit_q(now)).count(),
            "salesman_activity": [
                {"id": s.id, "name": person(s), "visits_today": s.visits_today, "new_dealers": new_by.get(s.id, 0),
                 "orders": s.orders, "followups_due": s.due, "last_visit_at": s.last_visit}
                for s in activity
            ],
            "recent_visits": [visit_row(v) for v in recent],
        })


class DealersView(APIView):
    permission_classes = [IsManagement]
    SORTS = {"name": "name", "name_desc": "-name", "recent": "-last_visit_at", "followup": "next_followup_at", "newest": "-created_at"}

    def get(self, request):
        p = request.query_params
        qs = Dealer.objects.select_related("status")
        owned = DealerOwnershipHistory.objects.filter(ended_at__isnull=True)
        if p.get("assignment") == "assigned":
            qs = qs.filter(pk__in=owned.values("dealer_id"))
        elif p.get("assignment") == "unassigned":
            qs = qs.exclude(pk__in=owned.values("dealer_id"))
        archive = p.get("archive", "active")
        if archive == "active":
            qs = qs.filter(is_archived=False)
        elif archive == "archived":
            qs = qs.filter(is_archived=True)
        for key in ("state", "status"):
            if p.get(key):
                qs = qs.filter(**{("state__iexact" if key == "state" else "status__name__iexact"): p[key]})
        if p.get("city"):
            qs = qs.filter(city__icontains=p["city"])
        if p.get("owner", "").isdigit():
            qs = qs.filter(pk__in=owned.filter(salesman_id=p["owner"]).values("dealer_id"))
        if p.get("not_owner", "").isdigit():  # e.g. Assign dealers: hide the ones this salesman already owns
            qs = qs.exclude(pk__in=owned.filter(salesman_id=p["not_owner"]).values("dealer_id"))
        if p.get("visit") == "stale":
            qs = qs.filter(stale_visit_q(timezone.now()))
        if p.get("q"):
            q = p["q"].strip()
            qs = qs.filter(Q(name__icontains=q) | Q(phone__icontains=q) | Q(city__icontains=q) | Q(state__icontains=q))
        qs = qs.order_by(self.SORTS.get(p.get("sort"), "name"), "id")

        count, page = paginate(request, qs)
        page = list(page)
        ids = [d.id for d in page]
        owners = {o.dealer_id: person(o.salesman) for o in owned.filter(dealer_id__in=ids).select_related("salesman__user")}
        grants = dict(effective_grants(DealerAccessGrant.objects.filter(dealer_id__in=ids)).values_list("dealer_id").annotate(n=Count("id")))
        base = Dealer.objects.filter(is_archived=False)
        owned_n = base.filter(pk__in=owned.values("dealer_id")).count()
        total = base.count()
        return Response({
            "summary": {"total": total, "owned": owned_n, "unassigned": total - owned_n,
                        "active": base.filter(status__name="Active").count()},
            "filters": {"states": sorted(set(Dealer.objects.exclude(state="").values_list("state", flat=True))),
                        "statuses": list(Dealer.objects.exclude(status=None).values_list("status__name", flat=True).distinct()),
                        "owners": [{"id": s.id, "name": person(s)} for s in Salesman.objects.select_related("user")]},
            "count": count,
            "results": [{
                "id": d.id, "name": d.name, "phone": d.phone,
                "location": ", ".join(x for x in (d.city, d.state) if x),
                "status": d.status.name if d.status else "",
                "owner": owners.get(d.id), "last_visit_at": d.last_visit_at,
                "next_followup": d.next_followup_at, "access": grants.get(d.id, 0),
            } for d in page],
        })


class SalesmenView(APIView):
    permission_classes = [IsManagement]

    def get(self, request):
        rows = Salesman.objects.select_related("user").prefetch_related("territories").order_by("user__first_name", "user__username")
        return Response([{
            "id": s.id, "name": person(s), "phone": s.phone_number, "email": s.user.email,
            "active": s.is_active, "username": s.user.username,
            "targets": {"daily_visits": s.daily_visit_target, "monthly_visits": s.monthly_visit_target,
                        "monthly_orders": s.monthly_order_target},
            "territories": [t.state + (f" / {t.city}" if t.city else "") for t in s.territories.all()],
        } for s in rows])


class VisitsView(APIView):
    permission_classes = [IsManagement]

    def get(self, request):
        p = request.query_params
        today = timezone.localdate()
        start = {"today": today, "week": today - timedelta(days=6), "month": today - timedelta(days=29)}.get(p.get("range", "month"))
        qs = Visit.objects.select_related("salesman__user", "dealer").prefetch_related("order_items", "followups")
        if start:
            qs = qs.filter(visited_at__date__gte=start)
        if p.get("q"):
            q = p["q"].strip()
            qs = qs.filter(
                Q(dealer__name__icontains=q) | Q(dealer__phone__icontains=q) | Q(dealer__city__icontains=q)
                | Q(salesman__user__first_name__icontains=q) | Q(salesman__user__last_name__icontains=q)
                | Q(salesman__user__username__icontains=q) | Q(salesman_name__icontains=q) | Q(order_items__product_name__icontains=q)
            ).distinct()
        qs = qs.order_by("visited_at" if p.get("sort") == "oldest" else "-visited_at", "-id")
        count, page = paginate(request, qs)
        return Response({
            "summary": {
                "visits": count,
                "active_salesmen": qs.values("salesman").distinct().count(),
                "new_dealers": qs.filter(dealer__created_at__date__gte=start or today - timedelta(days=36500)).values("dealer").distinct().count(),
                "orders": qs.filter(order_items__isnull=False).values("id").distinct().count(),
                "followups_due": Followup.objects.filter(status="pending", due_date__lte=today).count(),
            },
            "count": count,
            "results": [visit_row(v) for v in page],
        })


class FollowupsView(APIView):
    permission_classes = [IsManagement]

    def get(self, request):
        p = request.query_params
        today = timezone.localdate()
        base = Followup.objects.all()
        pend = base.filter(status="pending")
        summary = {
            "overdue": pend.filter(due_date__lt=today).count(),
            "due_today": pend.filter(due_date=today).count(),
            "upcoming": pend.filter(due_date__gt=today).count(),
            "completed": base.filter(status="completed").count(),
            "no_response": base.filter(outcome="no_answer").count(),
        }
        qs = base.select_related("salesman__user", "dealer")
        tab = p.get("tab", "all")
        qs = {
            "overdue": qs.filter(status="pending", due_date__lt=today),
            "due_today": qs.filter(status="pending", due_date=today),
            "upcoming": qs.filter(status="pending", due_date__gt=today),
            "completed": qs.filter(status="completed"),
        }.get(tab, qs)
        if p.get("q"):
            q = p["q"].strip()
            qs = qs.filter(
                Q(dealer__name__icontains=q) | Q(dealer__phone__icontains=q) | Q(notes__icontains=q)
                | Q(salesman__user__first_name__icontains=q) | Q(salesman__user__last_name__icontains=q)
                | Q(salesman__user__username__icontains=q)
            )
        qs = qs.order_by("-due_date" if p.get("sort") == "latest" else "due_date", "id")
        count, page = paginate(request, qs)
        return Response({
            "summary": summary, "count": count,
            "results": [{
                "id": f.id, "due_date": f.due_date, "due_time": f.due_time.strftime("%H:%M") if f.due_time else None,
                "salesman": person(f.salesman), "dealer": f.dealer.name,
                "location": ", ".join(x for x in (f.dealer.city, f.dealer.state) if x),
                "title": f.task or f.notes or "Follow up", "priority": f.priority, "outcome": f.outcome,
                "state": followup_state(f, today),
            } for f in page],
        })
