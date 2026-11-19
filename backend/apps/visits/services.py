from django.db import IntegrityError, transaction
from django.utils import timezone
from rest_framework.exceptions import NotFound, ValidationError

from apps.accounts.models import Salesman
from apps.dealers.access import accessible_dealers
from apps.dealers.models import Dealer, DealerContact, DealerOwnershipHistory, DealerStatus
from apps.dealers.phone import normalize_phone

from .exceptions import DealerNotAvailable, DuplicateDealer, NoSalesmanProfile
from . import photos as visit_photos
from .models import Followup, Product, Visit, VisitOrderItem


def normalize_gst(value: str) -> str:
    return (value or "").strip().upper()


def get_salesman(user) -> Salesman:
    salesman = Salesman.objects.filter(user=user, is_active=True).first()
    if salesman is None:
        raise NoSalesmanProfile()
    return salesman


def find_duplicate(*, name="", phone="", whatsapp="", gst_number="", city=""):
    """Match priority: phone -> WhatsApp -> GST. Searches ALL dealers.

    A dealer's name (even name + city) is NOT an identity: two shops may share a name. Only a mobile
    number (or a GST number) makes a new dealer a duplicate. `name` and `city` are still accepted so
    callers need not change."""
    phones = {p for p in (normalize_phone(phone), normalize_phone(whatsapp)) if len(p) >= 10}
    for p in phones:
        match = Dealer.objects.filter(phone=p).first() or Dealer.objects.filter(whatsapp=p).first()
        if match:
            return match
    gst = normalize_gst(gst_number)
    if gst:
        return Dealer.objects.filter(gst_number=gst).first()
    return None


def check_dealer_duplicate(user, **fields):
    """Returns None, or the accessible duplicate. Raises DealerNotAvailable for an inaccessible one."""
    match = find_duplicate(**fields)
    if match is None:
        return None
    if not accessible_dealers(user).filter(pk=match.pk).exists():
        raise DealerNotAvailable()
    return match


def _create_dealer(salesman, data) -> Dealer:
    status_obj, _ = DealerStatus.objects.get_or_create(name="New")
    # A fix taken on the new-dealer form is kept as an unverified location (no location_verified_*): management verifies it.
    has_fix = data.get("latitude") is not None and data.get("longitude") is not None
    location = (
        {"latitude": data["latitude"], "longitude": data["longitude"], "location_accuracy_m": data.get("location_accuracy_m"),
         "location_source": Dealer.LocationSource.GPS_CHECKIN}
        if has_fix else {}
    )
    dealer = Dealer.objects.create(
        name=data["name"].strip(),
        shop_name=data.get("shop_name", "").strip(),
        phone=normalize_phone(data.get("phone", "")),
        whatsapp=normalize_phone(data.get("whatsapp", "")),
        address=data.get("address", "").strip(),
        city=data.get("city", "").strip(),
        state=data.get("state", "").strip(),
        pincode=data.get("pincode", "").strip(),
        gst_number=normalize_gst(data.get("gst_number", "")),
        status=status_obj,
        primary_salesman=salesman,
        **location,
    )
    DealerOwnershipHistory.objects.create(dealer=dealer, salesman=salesman, reason="Created via visit")
    if has_fix:  # the shop-location history management sees starts with the salesman's own capture
        from apps.field.models import FieldAuditLog
        from apps.field.services import audit
        audit(salesman.user, FieldAuditLog.Action.DEALER_LOCATION_SET, salesman=salesman, dealer_id=dealer.id,
              via="new_dealer_form", after={"latitude": dealer.latitude, "longitude": dealer.longitude,
                                            "accuracy_m": dealer.location_accuracy_m, "verified": False, "source": dealer.location_source})
    contact_name = data.get("contact_name", "").strip()
    if contact_name:
        DealerContact.objects.create(
            dealer=dealer, name=contact_name, phone=dealer.phone, whatsapp=dealer.whatsapp
        )
    return dealer


def _resolve_order_items(items):
    ids = {i["product_id"] for i in items if i.get("product_id")}
    products = {p.id: p for p in Product.objects.filter(id__in=ids)}
    rows = []
    for idx, item in enumerate(items):
        pid = item.get("product_id")
        if pid:
            product = products.get(pid)
            if product is None or not product.is_active:
                raise ValidationError({"order_items": {idx: "Product is not available"}})
            rows.append((product, product.name, item["quantity"], item.get("unit", "pcs"), item.get("unit_price", 0)))
        else:
            rows.append((None, item["product_name"].strip(), item["quantity"], item.get("unit", "pcs"), item.get("unit_price", 0)))
    return rows


def record_visit(user, data) -> tuple[Visit, bool]:
    """One transaction: dealer (+ownership), visit, order lines, follow-up. Returns (visit, created)."""
    salesman = get_salesman(user)
    request_id = data.get("client_request_id")

    if request_id:
        existing = Visit.objects.filter(salesman=salesman, client_request_id=request_id).first()
        if existing:
            return existing, False

    order_rows = _resolve_order_items(data.get("order_items") or [])
    # Refuse a visit that is short of photos before anything is written (re-checked under lock inside the transaction).
    visit_photos.check_photo_ids(salesman, data.get("photo_ids"))

    try:
        with transaction.atomic():
            if request_id:
                # Re-check under the transaction: a concurrent identical submit may have just committed.
                existing = Visit.objects.filter(salesman=salesman, client_request_id=request_id).first()
                if existing:
                    return existing, False
            dealer_id = data.get("dealer_id")
            if dealer_id:
                # Inaccessible and nonexistent dealers are indistinguishable.
                dealer = accessible_dealers(user).select_for_update().filter(pk=dealer_id).first()
                if dealer is None:
                    raise NotFound("Dealer not found")
            else:
                new = data["new_dealer"]
                match = check_dealer_duplicate(
                    user,
                    name=new["name"], phone=new.get("phone", ""), whatsapp=new.get("whatsapp", ""),
                    gst_number=new.get("gst_number", ""), city=new.get("city", ""),
                )
                if match:
                    raise DuplicateDealer(match)
                dealer = _create_dealer(salesman, new)

            now = timezone.now()
            visit = Visit.objects.create(
                salesman=salesman,
                dealer=dealer,
                visited_at=data.get("visited_at") or now,
                salesman_lat=data.get("latitude"),
                salesman_lng=data.get("longitude"),
                visit_lat=data.get("latitude"),
                visit_lng=data.get("longitude"),
                location_source="browser_gps" if data.get("latitude") is not None else "",
                location_captured_at=now if data.get("latitude") is not None else None,
                notes=data.get("notes", "").strip(),
                source=Visit.Source.WEB,
                client_request_id=request_id,
            )
            VisitOrderItem.objects.bulk_create(
                VisitOrderItem(visit=visit, product=p, product_name=name, quantity=qty, unit=unit, unit_price=price)
                for p, name, qty, unit, price in order_rows
            )

            followup = data.get("followup")
            if followup:
                Followup.objects.create(
                    dealer=dealer, salesman=salesman, visit=visit,
                    due_date=followup["due_date"],
                    due_time=followup.get("due_time"),
                    priority=followup.get("priority", Followup.Priority.MEDIUM),
                    action=followup.get("action", ""),
                    action_text=followup.get("action_text", ""),
                    notes=followup.get("notes", ""),
                )
                dealer.next_followup_at = followup["due_date"]
            dealer.last_visit_at = visit.visited_at
            dealer.save(update_fields=["last_visit_at", "next_followup_at"])
            visit_photos.attach(salesman, visit, data.get("photo_ids"))
            return visit, True
    except IntegrityError:
        # Concurrent double submit lost the race on the unique request id.
        if request_id:
            existing = Visit.objects.filter(salesman=salesman, client_request_id=request_id).first()
            if existing:
                return existing, False
        # Or a concurrent request created a dealer with the same phone first (DB unique constraint).
        new = data.get("new_dealer")
        if new and not data.get("dealer_id"):
            match = check_dealer_duplicate(
                user,
                name=new["name"], phone=new.get("phone", ""), whatsapp=new.get("whatsapp", ""),
                gst_number=new.get("gst_number", ""), city=new.get("city", ""),
            )
            if match:
                raise DuplicateDealer(match)
            raise ValidationError({"new_dealer": {"phone": "Another dealer already uses this phone number"}})
        raise
