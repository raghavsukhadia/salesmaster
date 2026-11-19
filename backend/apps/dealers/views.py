from django.db import IntegrityError, transaction
from django.db.models import Count, Q
from django.utils import timezone
from rest_framework.exceptions import NotFound, PermissionDenied, ValidationError
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response
from rest_framework.views import APIView

from apps.accounts.models import Role, Salesman
from apps.accounts.permissions import IsAdmin
from apps.management.views import PAGE_SIZE, followup_state, person
from apps.visits.models import Followup, Visit
from apps.visits.services import normalize_gst, normalize_phone

from .access import accessible_dealers, effective_grants
from .models import Dealer, DealerAccessGrant, DealerOwnershipHistory, DealerStatus
from .serializers import DealerUpdateSerializer, GrantSerializer, TransferSerializer
from .services import add_grant, current_owner, is_current_owner, revoke_grant, transfer_ownership

EDITABLE = ("name", "shop_name", "phone", "whatsapp", "address", "city", "state", "pincode", "gst_number")
SALESMAN_EDITABLE = ("name", "address", "city", "state", "pincode")
TABS = ("visits", "orders", "followups", "activity")


def load_dealer(user, pk) -> Dealer:
    """Management sees every dealer; salesmen only ones they own or hold a grant for."""
    qs = Dealer.objects.all() if user.is_management else accessible_dealers(user)
    dealer = qs.select_related("status", "distributor").filter(pk=pk).first()
    if dealer is None:
        raise NotFound("Dealer not found")
    return dealer


def page_of(request, rows):
    try:
        page = max(1, int(request.query_params.get("page", 1)))
    except ValueError:
        page = 1
    return len(rows), rows[(page - 1) * PAGE_SIZE : page * PAGE_SIZE]


def serialize_profile(d: Dealer):
    return {
        "id": d.id, "name": d.name, "shop_name": d.shop_name, "phone": d.phone, "whatsapp": d.whatsapp,
        "address": d.address, "city": d.city, "state": d.state, "pincode": d.pincode, "gst_number": d.gst_number,
        "status": d.status.name if d.status else "", "distributor": d.distributor.name if d.distributor else "",
        "latitude": d.latitude, "longitude": d.longitude, "is_archived": d.is_archived,
        "last_visit_at": d.last_visit_at, "next_followup": d.next_followup_at, "created_at": d.created_at,
    }


class DealerDetailView(APIView):
    permission_classes = [IsAuthenticated]

    def get(self, request, pk):
        user = request.user
        dealer = load_dealer(user, pk)
        today = timezone.localdate()
        pending = dealer.followups.filter(status=Followup.Status.PENDING)
        owner = current_owner(dealer)
        data = {
            "profile": serialize_profile(dealer),
            "contacts": list(dealer.contacts.values("id", "name", "designation", "phone", "whatsapp", "email")),
            "stats": {
                "visits": dealer.visits.count(),
                "orders": dealer.visits.filter(order_items__isnull=False).distinct().count(),
                "pending_followups": pending.count(),
                "overdue_followups": pending.filter(due_date__lt=today).count(),
            },
            "permissions": {
                "can_edit": user.is_management,
                "can_transfer": user.role == Role.ADMIN,
                "can_manage_access": user.role == Role.ADMIN,
            },
        }
        if user.is_management:
            data["owner"] = {"id": owner.salesman_id, "name": person(owner.salesman), "since": owner.started_at} if owner else None
            data["ownership_history"] = [
                {"id": o.id, "salesman": person(o.salesman), "started_at": o.started_at, "ended_at": o.ended_at,
                 "reason": o.reason, "changed_by": o.changed_by.get_username() if o.changed_by else None}
                for o in dealer.ownerships.select_related("salesman__user", "changed_by").order_by("-started_at", "-id")
            ]
            data["grants"] = [
                {"id": g.id, "salesman_id": g.salesman_id, "salesman": person(g.salesman), "since": g.created_at,
                 "granted_by": g.created_by.get_username() if g.created_by else None}
                for g in effective_grants(dealer.dealeraccessgrant_set.all()).select_related("salesman__user", "created_by")
            ]
            if user.role == Role.ADMIN:
                data["salesman_options"] = [{"id": s.id, "name": person(s)} for s in Salesman.objects.filter(is_active=True).select_related("user")]
        else:
            # Salesmen are not told who else owns or can see a dealer.
            data["is_mine"] = bool(owner and owner.salesman.user_id == user.id)
        return Response(data)

    def patch(self, request, pk):
        user = request.user
        if not user.is_management:
            # Salesmen may fix the name and address of a dealer they own, nothing else (phone, GST, status, archive
            # stay with management). Forbidden fields are refused outright rather than silently ignored.
            if set(request.data) - set(SALESMAN_EDITABLE):
                raise PermissionDenied()
        dealer = load_dealer(user, pk)
        if not user.is_management and not is_current_owner(user, dealer):
            raise PermissionDenied()
        s = DealerUpdateSerializer(data=request.data, partial=True)
        s.is_valid(raise_exception=True)
        v = s.validated_data

        if "phone" in v:
            v["phone"] = normalize_phone(v["phone"])
        if "whatsapp" in v:
            v["whatsapp"] = normalize_phone(v["whatsapp"])
        if "gst_number" in v:
            v["gst_number"] = normalize_gst(v["gst_number"])

        errors = {}
        others = Dealer.objects.exclude(pk=dealer.pk)
        if v.get("phone") and others.filter(Q(phone=v["phone"]) | Q(whatsapp=v["phone"])).exists():
            errors["phone"] = "Another dealer already uses this phone number"
        # Same rule for WhatsApp, but only when it is being changed: the edit form re-sends every field, and
        # an older dealer may already share a WhatsApp number, which must not block unrelated edits.
        if v.get("whatsapp") and v["whatsapp"] != dealer.whatsapp and others.filter(
            Q(phone=v["whatsapp"]) | Q(whatsapp=v["whatsapp"])
        ).exists():
            errors["whatsapp"] = "Another dealer already uses this WhatsApp number"
        if v.get("gst_number") and others.filter(gst_number=v["gst_number"]).exists():
            errors["gst_number"] = "Another dealer already uses this GST number"
        if errors:
            raise ValidationError(errors)

        for f in EDITABLE:
            if f in v:
                setattr(dealer, f, v[f])
        if "status" in v:
            dealer.status = DealerStatus.objects.filter(name=v["status"]).first() if v["status"] else None
        if "is_archived" in v:
            dealer.is_archived = v["is_archived"]
        try:
            with transaction.atomic():
                dealer.save()
        except IntegrityError:
            # Lost a race against another request using the same phone (DB unique constraint).
            raise ValidationError({"phone": "Another dealer already uses this phone number"})
        return Response(serialize_profile(dealer))


class DealerTabView(APIView):
    """Paginated history for one dealer. Dealer-bounded, so merged in memory with a per-source cap."""

    permission_classes = [IsAuthenticated]
    CAP = 300

    def get(self, request, pk, tab):
        if tab not in TABS:
            raise NotFound()
        dealer = load_dealer(request.user, pk)
        today = timezone.localdate()
        try:
            page = max(1, int(request.query_params.get("page", 1) or 1))
        except ValueError:
            page = 1
        if tab in ("visits", "orders"):
            qs = dealer.visits.select_related("salesman__user").prefetch_related("order_items", "followups").order_by("-visited_at", "-id")
            if tab == "orders":
                qs = qs.filter(order_items__isnull=False).distinct()
            count = qs.count()
            rows = qs[(page - 1) * PAGE_SIZE : page * PAGE_SIZE]
            return Response({"count": count, "results": [self._visit(v, request.user) for v in rows]})
        if tab == "followups":
            qs = dealer.followups.select_related("salesman__user").order_by("-due_date", "-id")
            count = qs.count()
            return Response({"count": count, "results": [
                {"id": f.id, "due_date": f.due_date, "salesman": person(f.salesman), "priority": f.priority,
                 "outcome": f.outcome, "notes": f.notes, "state": followup_state(f, today)}
                for f in qs[(page - 1) * PAGE_SIZE : page * PAGE_SIZE]]})
        return self._activity(request, dealer)

    @staticmethod
    def _visit(v, user):
        items = [{"name": i.product_name, "quantity": i.quantity, "unit": i.unit} for i in v.order_items.all()]
        fu = next(iter(v.followups.all()), None)
        # `salesman` is whoever recorded the visit, read from the visit itself: a dealer transfer never rewrites it.
        return {"id": v.id, "visited_at": v.visited_at, "salesman": v.salesman_name, "mine": v.salesman.user_id == user.id,
                "notes": v.notes, "source": v.source, "has_order": bool(items), "items": items,
                "followup_due": fu.due_date if fu else None}

    def _activity(self, request, dealer):
        ev = []
        for v in dealer.visits.select_related("salesman__user").order_by("-visited_at")[: self.CAP]:
            ev.append({"at": v.visited_at, "type": "visit", "text": f"Visit by {v.salesman_name}" + (" with an order" if v.order_items.exists() else "")})
        for f in dealer.followups.select_related("salesman__user").order_by("-created_at")[: self.CAP]:
            ev.append({"at": f.created_at, "type": "followup", "text": f"Follow-up scheduled for {f.due_date:%d %b %Y} ({person(f.salesman)})"})
        if request.user.is_management:
            for o in dealer.ownerships.select_related("salesman__user", "changed_by").order_by("-started_at")[: self.CAP]:
                by = f" by {o.changed_by.get_username()}" if o.changed_by else ""
                ev.append({"at": o.started_at, "type": "ownership", "text": f"Assigned to {person(o.salesman)}{by}" + (f": {o.reason}" if o.reason else "")})
                if o.ended_at:
                    ev.append({"at": o.ended_at, "type": "ownership", "text": f"Ownership ended for {person(o.salesman)}"})
            for g in dealer.dealeraccessgrant_set.select_related("salesman__user", "created_by", "revoked_by").order_by("-created_at")[: self.CAP]:
                ev.append({"at": g.created_at, "type": "access", "text": f"Access granted to {person(g.salesman)}" + (f" by {g.created_by.get_username()}" if g.created_by else "")})
                if g.revoked_at:
                    ev.append({"at": g.revoked_at, "type": "access", "text": f"Access revoked for {person(g.salesman)}" + (f" by {g.revoked_by.get_username()}" if g.revoked_by else "")})
        ev.sort(key=lambda e: e["at"], reverse=True)
        count, page = page_of(request, ev)
        return Response({"count": count, "results": page})


class TransferView(APIView):
    permission_classes = [IsAdmin]

    def post(self, request, pk):
        s = TransferSerializer(data=request.data)
        s.is_valid(raise_exception=True)
        o = transfer_ownership(pk, s.validated_data["salesman_id"], request.user, s.validated_data.get("reason", ""))
        return Response({"owner": {"id": o.salesman_id, "name": person(o.salesman), "since": o.started_at}}, status=201)


class GrantListView(APIView):
    permission_classes = [IsAdmin]

    def post(self, request, pk):
        s = GrantSerializer(data=request.data)
        s.is_valid(raise_exception=True)
        g = add_grant(pk, s.validated_data["salesman_id"], request.user)
        return Response({"id": g.id, "salesman_id": g.salesman_id, "salesman": person(g.salesman), "since": g.created_at}, status=201)


class GrantRevokeView(APIView):
    permission_classes = [IsAdmin]

    def post(self, request, pk, grant_id):
        revoke_grant(pk, grant_id, request.user)
        return Response({"revoked": True})
