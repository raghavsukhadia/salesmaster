from django.db.models import Q
from rest_framework import serializers
from rest_framework.exceptions import ValidationError
from rest_framework.response import Response
from rest_framework.views import APIView

from apps.accounts.permissions import IsAdmin, IsManagement
from apps.dealers.models import Dealer, DealerOwnershipHistory
from apps.visits.models import Visit

from . import salesman_service as svc
from .views import paginate, person, visit_row

target = lambda: serializers.IntegerField(min_value=0, max_value=100000, required=False)  # noqa: E731


class ProfileSerializer(serializers.Serializer):
    first_name = serializers.CharField(max_length=150, required=False, allow_blank=True)
    last_name = serializers.CharField(max_length=150, required=False, allow_blank=True)
    email = serializers.EmailField(required=False, allow_blank=True)
    phone_number = serializers.CharField(max_length=20, required=False)
    daily_visit_target = target()
    monthly_visit_target = target()
    monthly_order_target = target()


class UpdateSerializer(ProfileSerializer):
    is_active = serializers.BooleanField(required=False)


class CreateSerializer(ProfileSerializer):
    username = serializers.RegexField(r"^[\w.@+-]+$", max_length=150)
    password = serializers.CharField(max_length=128, trim_whitespace=False)
    phone_number = serializers.CharField(max_length=20)
    first_name = serializers.CharField(max_length=150)


class PasswordSerializer(serializers.Serializer):
    password = serializers.CharField(max_length=128, trim_whitespace=False)


class TerritoryRow(serializers.Serializer):
    state = serializers.CharField(max_length=100)
    city = serializers.CharField(max_length=100, required=False, allow_blank=True, default="")


class TerritoriesSerializer(serializers.Serializer):
    territories = TerritoryRow(many=True, max_length=100)


class AssignSerializer(serializers.Serializer):
    dealer_ids = serializers.ListField(child=serializers.IntegerField(), min_length=1)
    reason = serializers.CharField(max_length=300, required=False, allow_blank=True, default="")


class OffboardSerializer(serializers.Serializer):
    transfer_to = serializers.IntegerField(required=False, allow_null=True, default=None)
    reason = serializers.CharField(max_length=300, required=False, allow_blank=True, default="")


def valid(serializer_cls, request):
    s = serializer_cls(data=request.data)
    s.is_valid(raise_exception=True)
    return s.validated_data


def detail(s):
    return {
        "id": s.id, "username": s.user.username, "first_name": s.user.first_name, "last_name": s.user.last_name,
        "name": person(s), "email": s.user.email, "phone": s.phone_number, "active": s.is_active,
        "targets": {"daily_visits": s.daily_visit_target, "monthly_visits": s.monthly_visit_target,
                    "monthly_orders": s.monthly_order_target},
        "territories": [{"state": t.state, "city": t.city} for t in s.territories.all()],
        "performance": svc.performance(s),
    }


class SalesmanCreateView(APIView):
    permission_classes = [IsAdmin]

    def post(self, request):
        s = svc.create_salesman(valid(CreateSerializer, request))
        return Response(detail(s), status=201)


class SalesmanDetailView(APIView):
    def get_permissions(self):
        return [(IsAdmin if self.request.method == "DELETE" else IsManagement)()]

    def get(self, request, pk):
        return Response(detail(svc.get_salesman_or_404(pk)))

    def patch(self, request, pk):
        s = svc.get_salesman_or_404(pk)
        svc.update_salesman(s, valid(UpdateSerializer, request))
        return Response(detail(svc.get_salesman_or_404(pk)))

    def delete(self, request, pk):
        svc.delete_salesman(svc.get_salesman_or_404(pk))
        return Response(status=204)


class ResetPasswordView(APIView):
    permission_classes = [IsAdmin]

    def post(self, request, pk):
        svc.reset_password(svc.get_salesman_or_404(pk), valid(PasswordSerializer, request)["password"])
        return Response({"ok": True})


class TerritoriesView(APIView):
    permission_classes = [IsAdmin]

    def put(self, request, pk):
        s = svc.get_salesman_or_404(pk)
        svc.set_territories(s, valid(TerritoriesSerializer, request)["territories"])
        return Response(detail(svc.get_salesman_or_404(pk)))


class AssignDealersView(APIView):
    permission_classes = [IsAdmin]

    def post(self, request, pk):
        s = svc.get_salesman_or_404(pk)
        d = valid(AssignSerializer, request)
        return Response(svc.assign_dealers(s, d["dealer_ids"], request.user, d["reason"]))


class OffboardView(APIView):
    permission_classes = [IsAdmin]

    def post(self, request, pk):
        s = svc.get_salesman_or_404(pk)
        d = valid(OffboardSerializer, request)
        if d["transfer_to"] is not None:
            target_s = svc.get_salesman_or_404(d["transfer_to"])
            if not target_s.is_active:
                raise ValidationError({"transfer_to": "The receiving salesman is inactive"})
        return Response(svc.offboard(s, request.user, d["transfer_to"], d["reason"]))


class SalesmanVisitsView(APIView):
    permission_classes = [IsManagement]

    def get(self, request, pk):
        s = svc.get_salesman_or_404(pk)
        qs = (Visit.objects.filter(salesman=s).select_related("salesman__user", "dealer")
              .prefetch_related("order_items", "followups").order_by("-visited_at", "-id"))
        count, page = paginate(request, qs)
        return Response({"count": count, "results": [visit_row(v) for v in page]})


class SalesmanDealersView(APIView):
    permission_classes = [IsManagement]

    def get(self, request, pk):
        s = svc.get_salesman_or_404(pk)
        ids = DealerOwnershipHistory.objects.filter(salesman=s, ended_at__isnull=True).values("dealer_id")
        qs = Dealer.objects.filter(pk__in=ids).select_related("status").order_by("name", "id")
        if q := request.query_params.get("q", "").strip():
            qs = qs.filter(Q(name__icontains=q) | Q(phone__icontains=q) | Q(city__icontains=q))
        count, page = paginate(request, qs)
        return Response({"count": count, "results": [{
            "id": d.id, "name": d.name, "phone": d.phone,
            "location": ", ".join(x for x in (d.city, d.state) if x),
            "status": d.status.name if d.status else "", "last_visit_at": d.last_visit_at,
        } for d in page]})
