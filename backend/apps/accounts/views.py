from django.db.models import Q
from rest_framework.response import Response
from rest_framework.views import APIView
from rest_framework_simplejwt.views import TokenObtainPairView

from apps.dealers.access import accessible_dealers

from .permissions import IsAdmin, IsManagement, IsSalesman
from .serializers import LoginSerializer
from .throttles import LoginAccountThrottle, LoginAddressThrottle


class LoginView(TokenObtainPairView):
    """The stock JWT sign-in, with guess limits. Both throttles count every attempt, successful or not."""

    serializer_class = LoginSerializer
    throttle_classes = [LoginAccountThrottle, LoginAddressThrottle]


class MeView(APIView):
    def get(self, request):
        u = request.user
        # `name` is what the header shows; `designation` is the role as a person would say it ("Salesman").
        return Response({
            "id": u.id, "username": u.username, "role": u.role,
            "name": u.get_full_name().strip() or u.username, "designation": u.get_role_display(),
        })


class SalesmanDealersView(APIView):
    """Salesman-scoped dealer list (ownership + grants only). Placeholder for the Record Visit search."""

    permission_classes = [IsSalesman]

    def get(self, request):
        qs = accessible_dealers(request.user)
        q = request.query_params.get("q", "").strip()
        if q:
            qs = qs.filter(Q(name__icontains=q) | Q(shop_name__icontains=q) | Q(phone__icontains=q))
        return Response(list(qs.order_by("name").values("id", "name", "city", "phone")[:25]))


class ManagementPingView(APIView):
    permission_classes = [IsManagement]

    def get(self, request):
        return Response({"ok": True})


class AdminPingView(APIView):
    permission_classes = [IsAdmin]

    def get(self, request):
        return Response({"ok": True})
