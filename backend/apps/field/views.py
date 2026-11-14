"""Salesman-facing field endpoints (duty sessions, GPS upload, nearby dealers). Salesman role only."""
from django.conf import settings
from django.utils import timezone
from rest_framework import status
from rest_framework.response import Response
from rest_framework.throttling import ScopedRateThrottle
from rest_framework.views import APIView

from apps.accounts.permissions import IsSalesman
from apps.visits.services import get_salesman

from . import beats, checkins, nearby, services
from .models import FieldConfig, WorkSession
from .rules import RuleErrorMixin
from .serializers import (
    CheckInSerializer, CheckOutSerializer, ConsentSerializer, NearbyQuerySerializer, PointBatchSerializer, ReasonSerializer,
)


def policy_payload(cfg: FieldConfig) -> dict:
    """What the salesman is told before going on duty, and what the app keeps showing while on duty."""
    return {
        "consent_version": settings.FIELD_TRACKING["CONSENT_VERSION"],
        "ping_interval_s": cfg.ping_interval_s,
        "retention_days": cfg.retention_days,
        "notice": [
            "Your location is recorded only between Start duty and End duty. Nothing is recorded when you are off duty.",
            "Your managers and administrators can see your latest location and today's route while you are on duty.",
            f"Location points are deleted after {cfg.retention_days} days.",
            "Each time a manager opens your route history, it is logged.",
            "This web app can only record while it is open on your phone. Keep it open and allow location access.",
        ],
    }


def own_state(salesman, now=None) -> dict:
    now = now or timezone.now()
    session = services.get_active_session(salesman, now)
    cfg = FieldConfig.get()
    return {
        "on_duty": session is not None,
        "server_time": now,
        "session": None if session is None else {
            "id": session.id, "started_at": session.started_at, "ping_count": session.ping_count,
            "last_contact_at": session.last_contact_at, "last_fix": services.last_fix(session),
        },
        "tracking": services.tracking_status(session, now),
        "policy": policy_payload(cfg),
    }


class SessionView(APIView):
    permission_classes = [IsSalesman]

    def get(self, request):
        return Response(own_state(get_salesman(request.user)))


class SessionStartView(APIView):
    permission_classes = [IsSalesman]

    def post(self, request):
        s = ConsentSerializer(data=request.data)
        s.is_valid(raise_exception=True)
        salesman = get_salesman(request.user)
        _, created = services.start_session(
            request.user, salesman, consent=s.validated_data["consent"],
            consent_version=s.validated_data["consent_version"],
        )
        return Response(own_state(salesman), status=status.HTTP_201_CREATED if created else status.HTTP_200_OK)


class SessionEndView(APIView):
    permission_classes = [IsSalesman]

    def post(self, request):
        salesman = get_salesman(request.user)
        services.end_session(request.user, salesman, reason=WorkSession.EndReason.MANUAL)
        return Response(own_state(salesman))


class LocationBatchView(APIView):
    """Accepts live or offline-queued fixes. Each point is judged individually so a client can drop the
    permanently rejected ones and retry only what failed in transit."""

    permission_classes = [IsSalesman]
    throttle_classes = [ScopedRateThrottle]
    throttle_scope = "field_ping"

    def post(self, request):
        s = PointBatchSerializer(data=request.data)
        s.is_valid(raise_exception=True)
        salesman = get_salesman(request.user)
        now = timezone.now()
        result = services.ingest_points(
            salesman, s.validated_data["points"], sent_at=s.validated_data.get("sent_at"), now=now
        )
        session = services.get_active_session(salesman, now)
        return Response({
            "accepted": result.accepted,
            "duplicates": result.duplicates,
            "rejected": result.rejected,
            "on_duty": session is not None,
            "tracking": services.tracking_status(session, now),
            "server_time": now,
        })


class NearbyDealersView(APIView):
    """Dealers this salesman owns or holds access to, around a position they send."""

    permission_classes = [IsSalesman]

    def get(self, request):
        q = NearbyQuerySerializer(data=request.query_params)
        q.is_valid(raise_exception=True)
        v = q.validated_data
        get_salesman(request.user)  # an inactive profile gets the same 403 as everywhere else
        return Response(nearby.nearby_dealers(
            request.user, v["latitude"], v["longitude"], v["radius_km"], verified_only=v["verified_only"]
        ))


def geofence_policy() -> dict:
    cfg = FieldConfig.get()
    return {"default_radius_m": cfg.default_geofence_m, "mode": cfg.geofence_mode, "max_accuracy_m": settings.FIELD_TRACKING["CHECKIN_MAX_ACCURACY_M"]}


class TodayView(RuleErrorMixin, APIView):
    """The salesman's day: today's beat, any open check-in, and the geofence rules in force."""

    permission_classes = [IsSalesman]

    def get(self, request):
        salesman = get_salesman(request.user)
        today = timezone.localdate()
        open_ = checkins.open_checkin(salesman)
        return Response({
            "date": today,
            "plan": beats.plan_payload(beats.get_plan(salesman, today)),
            "open_checkin": checkins.checkin_payload(open_) if open_ else None,
            "geofence": geofence_policy(),
        })


class CheckInView(RuleErrorMixin, APIView):
    permission_classes = [IsSalesman]

    def post(self, request):
        s = CheckInSerializer(data=request.data)
        s.is_valid(raise_exception=True)
        v = s.validated_data
        salesman = get_salesman(request.user)
        checkin, created = checkins.check_in(
            request.user, salesman, dealer_id=v["dealer_id"], position=v["position"], sent_at=v.get("sent_at"),
            reason=v.get("reason", ""), client_request_id=v.get("client_request_id"),
        )
        return Response(checkins.checkin_payload(checkin), status=status.HTTP_201_CREATED if created else status.HTTP_200_OK)


class CheckOutView(RuleErrorMixin, APIView):
    permission_classes = [IsSalesman]

    def post(self, request, pk):
        s = CheckOutSerializer(data=request.data)
        s.is_valid(raise_exception=True)
        v = s.validated_data
        salesman = get_salesman(request.user)
        checkin, created = checkins.check_out(
            request.user, salesman, pk, position=v["position"], sent_at=v.get("sent_at"), outcome=v["outcome"],
            notes=v.get("notes", ""), has_order=v["has_order"], order_items=v["order_items"], followup=v.get("followup"),
            reason=v.get("reason", ""), client_request_id=v.get("client_request_id"), photo_ids=v.get("photo_ids"),
        )
        return Response(checkins.checkin_payload(checkin), status=status.HTTP_200_OK)


class SkipStopView(RuleErrorMixin, APIView):
    permission_classes = [IsSalesman]

    def post(self, request, pk):
        s = ReasonSerializer(data=request.data)
        s.is_valid(raise_exception=True)
        salesman = get_salesman(request.user)
        beats.skip_stop(salesman, pk, s.validated_data.get("reason", ""))
        return Response(beats.plan_payload(beats.get_plan(salesman, timezone.localdate())))
