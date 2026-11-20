from django.db.models import Q
from rest_framework.response import Response
from rest_framework.throttling import ScopedRateThrottle
from rest_framework.views import APIView
from rest_framework_simplejwt.tokens import RefreshToken
from rest_framework_simplejwt.views import TokenObtainPairView

from apps.dealers.access import dealers_added_by

from .permissions import IsAdmin, IsManagement, IsSalesman
from .serializers import ChangePasswordSerializer, LoginSerializer
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


class ChangePasswordView(APIView):
    """Any signed-in user changes their own password.

    Tokens carry a hash of the password they were issued under (SIMPLE_JWT CHECK_REVOKE_TOKEN), so this signs the account
    out everywhere, this browser included. The reply therefore carries a fresh token pair for the caller to keep, and every
    other session has to sign in again. Guesses at the current password are rate limited.
    """

    throttle_classes = [ScopedRateThrottle]
    throttle_scope = "password_change"

    def post(self, request):
        s = ChangePasswordSerializer(data=request.data, context={"request": request})
        s.is_valid(raise_exception=True)
        user = request.user
        user.set_password(s.validated_data["new_password"])
        user.save(update_fields=["password"])
        refresh = RefreshToken.for_user(user)
        return Response({"refresh": str(refresh), "access": str(refresh.access_token)})


class SalesmanDealersView(APIView):
    """Record Visit "Existing Dealer" search: only dealers this salesman added themselves, not imported/assigned ones."""

    permission_classes = [IsSalesman]

    def get(self, request):
        qs = dealers_added_by(request.user)
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
