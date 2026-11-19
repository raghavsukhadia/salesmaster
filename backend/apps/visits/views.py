from rest_framework import status
from rest_framework.response import Response
from rest_framework.views import APIView

from apps.accounts.permissions import IsSalesman

from .models import Product
from .serializers import DuplicateCheckSerializer, RecordVisitSerializer
from .services import check_dealer_duplicate, record_visit


class DuplicateCheckView(APIView):
    permission_classes = [IsSalesman]

    def post(self, request):
        s = DuplicateCheckSerializer(data=request.data)
        s.is_valid(raise_exception=True)
        match = check_dealer_duplicate(request.user, **s.validated_data)
        if match is None:
            return Response({"duplicate": False})
        return Response({"duplicate": True, "dealer": {"id": match.id, "name": match.name, "city": match.city}})


class ProductListView(APIView):
    """Active catalogue for the order picker. Read-only for any authenticated user.

    The picker loads the whole catalogue once and filters it as the salesman types, so the cap is generous."""

    def get(self, request):
        qs = Product.objects.filter(is_active=True)
        q = request.query_params.get("q", "").strip()
        if q:
            qs = qs.filter(name__icontains=q)
        return Response(list(qs.order_by("name").values("id", "name", "category")[:1000]))


class RecordVisitView(APIView):
    permission_classes = [IsSalesman]

    def post(self, request):
        s = RecordVisitSerializer(data=request.data)
        s.is_valid(raise_exception=True)
        visit, created = record_visit(request.user, s.validated_data)
        return Response(
            {"visit_id": visit.id, "dealer_id": visit.dealer_id, "created": created},
            status=status.HTTP_201_CREATED if created else status.HTTP_200_OK,
        )
