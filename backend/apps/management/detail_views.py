from math import asin, cos, radians, sin, sqrt

from django.utils import timezone
from rest_framework.exceptions import NotFound
from rest_framework.response import Response
from rest_framework.views import APIView

from apps.accounts.permissions import IsManagement
from apps.visits.models import Followup, Visit

from .views import followup_state, person


def num(v):
    return float(v) if v is not None else None


def distance_m(a_lat, a_lng, b_lat, b_lng):
    """Great-circle distance in metres, or None when either point is missing."""
    if None in (a_lat, a_lng, b_lat, b_lng):
        return None
    p1, p2 = radians(a_lat), radians(b_lat)
    h = sin((p2 - p1) / 2) ** 2 + cos(p1) * cos(p2) * sin(radians(b_lng - a_lng) / 2) ** 2
    return round(12742000 * asin(sqrt(h)))


def dealer_block(d, owner):
    return {
        "id": d.id, "name": d.name, "shop_name": d.shop_name, "phone": d.phone, "whatsapp": d.whatsapp,
        "address": d.address, "city": d.city, "state": d.state, "pincode": d.pincode, "gst_number": d.gst_number,
        "status": d.status.name if d.status else "", "archived": d.is_archived,
        "owner": person(owner.salesman) if owner else None,
    }


def salesman_block(s):
    return {"id": s.id, "name": person(s), "phone": s.phone_number, "email": s.user.email, "active": s.is_active}


def current_owner(dealer):
    return next((o for o in dealer.ownerships.all() if o.ended_at is None), None)


from apps.visits.photos import photos_payload  # noqa: E402


class ManagementVisitDetailView(APIView):
    permission_classes = [IsManagement]

    def get(self, request, pk):
        v = (Visit.objects.select_related("salesman__user", "dealer__status")
             .prefetch_related("order_items", "interests__product", "followups", "photos", "dealer__ownerships__salesman__user")
             .filter(pk=pk).first())
        if v is None:
            raise NotFound("Visit not found")
        d, today = v.dealer, timezone.localdate()
        d_lat, d_lng = num(d.latitude), num(d.longitude)
        items = [{
            "id": i.id, "name": i.product_name, "quantity": i.quantity, "unit": i.unit,
            "unit_price": float(i.unit_price), "line_total": float(i.quantity * i.unit_price),
            "catalogue": i.product_id is not None,
        } for i in v.order_items.all()]
        return Response({
            "id": v.id, "visited_at": v.visited_at, "recorded_at": v.created_at, "source": v.source, "notes": v.notes,
            "dealer": dealer_block(d, current_owner(d)),
            "salesman": {**salesman_block(v.salesman), "name": v.salesman_name},
            "location": {
                "visit": {"lat": num(v.visit_lat), "lng": num(v.visit_lng)},
                "salesman": {"lat": num(v.salesman_lat), "lng": num(v.salesman_lng)},
                "dealer": {"lat": d_lat, "lng": d_lng},
                "source": v.location_source, "captured_at": v.location_captured_at,
                "distance_from_dealer_m": distance_m(num(v.visit_lat), num(v.visit_lng), d_lat, d_lng),
            },
            "order": {"has_order": bool(items), "items": items, "total_quantity": sum(i["quantity"] for i in items),
                      "total_amount": round(sum(i["line_total"] for i in items), 2)},
            "interests": [i.product.name for i in v.interests.all()],
            "photos": photos_payload(v),
            "followups": [{
                "id": f.id, "due_date": f.due_date, "due_time": f.due_time.strftime("%H:%M") if f.due_time else None,
                "priority": f.priority, "status": f.status, "outcome": f.outcome,
                "notes": f.notes, "state": followup_state(f, today),
            } for f in v.followups.all()],
        })


class ManagementFollowupDetailView(APIView):
    permission_classes = [IsManagement]

    def get(self, request, pk):
        f = (Followup.objects.select_related("salesman__user", "dealer__status", "visit__salesman__user", "parent__salesman__user")
             .prefetch_related("children__salesman__user", "dealer__ownerships__salesman__user")
             .filter(pk=pk).first())
        if f is None:
            raise NotFound("Follow-up not found")
        today = timezone.localdate()
        state = followup_state(f, today)
        who = person(f.salesman)

        # Follow-ups keep no per-action log, so history is derived from the records that link to them.
        events = []
        if f.visit:
            events.append({"at": f.visit.visited_at, "type": "visit", "text": f"Visit recorded by {f.visit.salesman_name}"})
        events.append({"at": f.created_at, "type": "created", "text": f"Follow-up scheduled for {f.due_date:%d %b %Y} ({who})"})
        if f.parent:
            events.append({"at": f.parent.created_at, "type": "parent", "text": f"Follows up on an earlier follow-up due {f.parent.due_date:%d %b %Y} ({f.parent.status})"})
        for c in f.children.all():
            events.append({"at": c.created_at, "type": "child", "text": f"Next follow-up #{c.id} scheduled for {c.due_date:%d %b %Y} ({c.status})"})
        events.sort(key=lambda e: e["at"], reverse=True)

        d = f.dealer
        return Response({
            "id": f.id, "due_date": f.due_date, "due_time": f.due_time.strftime("%H:%M") if f.due_time else None,
            "created_at": f.created_at, "status": f.status, "state": state,
            "priority": f.priority, "outcome": f.outcome, "notes": f.notes,
            "days_overdue": (today - f.due_date).days if state == "overdue" else 0,
            "dealer": dealer_block(d, current_owner(d)),
            "salesman": salesman_block(f.salesman),
            "visit": {"id": f.visit_id, "visited_at": f.visit.visited_at} if f.visit else None,
            "parent_id": f.parent_id,
            "next_ids": [c.id for c in f.children.all()],
            "history": events,
        })
