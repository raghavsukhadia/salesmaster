from rest_framework import serializers
from rest_framework.response import Response
from rest_framework.views import APIView

from apps.accounts.models import Salesman
from apps.accounts.permissions import IsAdmin, IsManagement
from apps.dealers.models import Dealer, DealerAccessGrant

from . import scope_service as svc
from .views import PAGE_SIZE, person


class ScopeSerializer(serializers.Serializer):
    mode = serializers.ChoiceField(choices=svc.MODES)
    owner_id = serializers.IntegerField(required=False, allow_null=True)
    state = serializers.CharField(max_length=80, required=False, allow_blank=True)
    city = serializers.CharField(max_length=80, required=False, allow_blank=True)
    dealer_id = serializers.IntegerField(required=False, allow_null=True)


class TransferSerializer(ScopeSerializer):
    to_salesman_id = serializers.IntegerField()
    reason = serializers.ChoiceField(choices=list(svc.TRANSFER_REASONS), required=False, default="manual")
    reassign_followups = serializers.BooleanField(required=False, default=True)


class GrantSerializer(ScopeSerializer):
    salesman_id = serializers.IntegerField()
    access_type = serializers.ChoiceField(choices=DealerAccessGrant.AccessType.values, required=False)
    starts_on = serializers.DateField(required=False, allow_null=True)
    ends_on = serializers.DateField(required=False, allow_null=True)


class CleanupAssignSerializer(serializers.Serializer):
    salesman_id = serializers.IntegerField()
    state = serializers.CharField(max_length=80, allow_blank=True)
    city = serializers.CharField(max_length=80, allow_blank=True)
    status = serializers.CharField(required=False, allow_blank=True)
    q = serializers.CharField(required=False, allow_blank=True)


def valid(serializer_cls, request) -> dict:
    s = serializer_cls(data=request.data)
    s.is_valid(raise_exception=True)
    return s.validated_data


class ScopeOptionsView(APIView):
    """Dropdown data for the transfer / grant / cleanup forms."""

    permission_classes = [IsManagement]

    def get(self, request):
        dealers = Dealer.objects.filter(is_archived=False)
        pairs = dealers.exclude(city="").values_list("state", "city").distinct().order_by("state", "city")[:1000]
        return Response({
            "salesmen": [{"id": s.id, "name": person(s), "active": s.is_active}
                         for s in Salesman.objects.select_related("user").order_by("user__first_name", "user__username")],
            "states": sorted(set(dealers.exclude(state="").values_list("state", flat=True))),
            "cities": [{"state": s, "city": c} for s, c in pairs],
            "reasons": [{"value": k, "label": v} for k, v in svc.TRANSFER_REASONS.items()],
            "access_types": [{"value": v, "label": l} for v, l in DealerAccessGrant.AccessType.choices],
        })


class OwnerAreasView(APIView):
    """States a salesman currently holds dealers in (with dealer and past-order counts) for the Transfer Area picker."""

    permission_classes = [IsManagement]

    def get(self, request):
        raw = request.query_params.get("owner_id", "")
        return Response({"areas": svc.owner_areas(int(raw) if raw.isdigit() else None)})


class TransferPreviewView(APIView):
    permission_classes = [IsAdmin]

    def post(self, request):
        return Response(svc.preview_transfer(valid(TransferSerializer, request)))


class TransferExecuteView(APIView):
    permission_classes = [IsAdmin]

    def post(self, request):
        return Response(svc.execute_transfer(valid(TransferSerializer, request), request.user), status=201)


class CleanupView(APIView):
    permission_classes = [IsManagement]

    def get(self, request):
        return Response(svc.cleanup_groups(request.query_params))


class CleanupAssignView(APIView):
    permission_classes = [IsAdmin]

    def post(self, request):
        return Response(svc.assign_unowned(valid(CleanupAssignSerializer, request), request.user), status=201)


class AccessGrantsView(APIView):
    def get_permissions(self):
        return [(IsAdmin if self.request.method == "POST" else IsManagement)()]

    def get(self, request):
        p = request.query_params
        try:
            page = max(1, int(p.get("page", 1)))
        except ValueError:
            page = 1
        status = p.get("status", "")
        count, rows, today = svc.list_grants(status, page, PAGE_SIZE)
        return Response({
            "count": count, "page_size": PAGE_SIZE,
            "results": [{
                "id": g.id,
                "grantee": person(g.salesman),
                "source_owner": person(g.owner) if g.owner_id else None,
                "scope": g.dealer.name if g.dealer_id else ", ".join(x for x in (g.city, g.state) if x) or "All dealers",
                "scope_kind": "dealer" if g.dealer_id else "owner",
                "type": g.get_access_type_display(),
                "starts_on": g.starts_on or g.created_at.date(),
                "ends_on": g.ends_on,
                "status": svc.grant_status(g, today),
                "revocable": g.revoked_at is None,
            } for g in rows],
        })

    def post(self, request):
        g = svc.create_grant(valid(GrantSerializer, request), request.user)
        return Response({"id": g.id}, status=201)


class AccessGrantPreviewView(APIView):
    permission_classes = [IsAdmin]

    def post(self, request):
        return Response(svc.preview_grant(valid(GrantSerializer, request)))


class AccessGrantRevokeView(APIView):
    permission_classes = [IsAdmin]

    def post(self, request, pk):
        svc.revoke_any_grant(pk, request.user)
        return Response({"revoked": True})
