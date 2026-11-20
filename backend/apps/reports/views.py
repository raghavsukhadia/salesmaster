"""Read-only report endpoints. Everything here is GET: reports never change data."""
from django.db.models import Count, Max, Q
from django.http import HttpResponse
from rest_framework.exceptions import NotFound, ValidationError
from rest_framework.response import Response
from rest_framework.views import APIView

from apps.accounts.models import Role, Salesman
from apps.accounts.permissions import HasRole
from apps.dealers.access import accessible_dealers
from apps.dealers.models import Dealer
from apps.management.views import person
from apps.visits.models import Product

from . import activity_reports as act
from . import people_reports as people
from . import sales_reports as sales
from .common import Ctx, where
from .export import CONTENT_TYPES, build_export
from .scope import PKEY, lines, parse_filters

REPORTS = {
    "overview": sales.overview,
    "date-wise": sales.date_wise,
    "salesman-wise": people.salesmen,
    "dealer-wise": people.dealers,
    "product-wise": sales.products,
    "salesman-product": people.salesman_product,
    "order-wise": sales.orders,
    "periods": sales.periods,
    "visit-performance": act.visit_performance,
    "followup-reports": act.followup_reports,
    "sales-targets": act.targets,
    "compare": act.compare,
}
DETAILS = {"salesman-wise": people.salesman_detail, "dealer-wise": people.dealer_detail}


class CanViewReports(HasRole):
    """Management sees company-wide numbers; salesmen get the same screens scoped to their own records (see scope.py)."""

    allowed_roles = (Role.ADMIN, Role.MANAGER, Role.SALESMAN)


def run(request, slug, pk=None, *, export=False):
    build = (DETAILS if pk is not None else REPORTS).get(slug)
    if build is None:
        raise NotFound("Unknown report")
    return build(Ctx(parse_filters(request), request.query_params, export=export, pk=pk))


class ReportView(APIView):
    permission_classes = [CanViewReports]

    def get(self, request, slug, pk=None):
        return Response(run(request, slug, pk))


class ExportView(APIView):
    permission_classes = [CanViewReports]

    def get(self, request, slug, pk=None):
        # Not `format`: DRF reserves ?format= for content negotiation and would 404 before this view runs.
        fmt = request.query_params.get("file", "xlsx")
        if fmt not in CONTENT_TYPES:
            raise ValidationError({"file": "Use xlsx or pdf"})
        data = run(request, slug, pk, export=True)
        body, filename = build_export(data, fmt)
        resp = HttpResponse(body, content_type=CONTENT_TYPES[fmt])
        resp["Content-Disposition"] = f'attachment; filename="{filename}"'
        resp["Cache-Control"] = "no-store"
        return resp


class OptionsView(APIView):
    """Choices for the filter bar. Salesmen get no salesman list (they can only ever see themselves)."""

    permission_classes = [CanViewReports]

    def get(self, request):
        f = parse_filters(request)
        pool = f.with_(product="", category="", dealer_id=None, order_id=None)
        salesmen = []
        if f.management:
            salesmen = [{"id": s.id, "name": person(s), "active": s.is_active}
                        for s in Salesman.objects.select_related("user").order_by("user__first_name", "user__username")]
        units = sorted(lines(pool.with_(unit=""), dated=False).order_by().values_list("unit", flat=True).distinct())
        cats = sorted({c for c in Product.objects.exclude(category="").values_list("category", flat=True)}, key=str.lower)
        products = [{"value": f"p{p.id}", "label": p.name, "category": p.category, "custom": False} for p in Product.objects.order_by("name")]
        custom = (lines(pool, dated=False).filter(product__isnull=True).annotate(pkey=PKEY).values("pkey")
                  .annotate(label=Max("product_name"), n=Count("id")).order_by("-n", "label"))
        products += [{"value": r["pkey"], "label": r["label"], "category": "", "custom": True} for r in custom]
        return Response({
            "role": request.user.role, "management": f.management, "salesmen": salesmen, "categories": cats, "products": products, "units": units,
            "months": act.compare_options(Ctx(pool, request.query_params))["months"],
        })


class DealerOptionsView(APIView):
    """Type-ahead for the dealer filter, limited to dealers the caller may see."""

    permission_classes = [CanViewReports]

    def get(self, request):
        user = request.user
        pool = Dealer.objects.all() if user.is_management else accessible_dealers(user)
        p = request.query_params
        if p.get("id", "").isdigit():
            pool = pool.filter(pk=int(p["id"]))
        else:
            q = (p.get("q") or "").strip()[:80]
            if q:
                pool = pool.filter(Q(name__icontains=q) | Q(phone__icontains=q) | Q(city__icontains=q) | Q(shop_name__icontains=q))
        return Response([{"id": d.id, "name": d.name, "location": where(d)} for d in pool.order_by("name")])
