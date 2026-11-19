"""Bulk-add dealers from an Excel / CSV sheet, each optionally owned by a salesman straight away (so it shows in their My Dealers)."""

import re

from django.db import IntegrityError, transaction
from rest_framework.exceptions import ValidationError
from rest_framework.parsers import FormParser, JSONParser, MultiPartParser
from rest_framework.response import Response
from rest_framework.views import APIView

from apps.accounts.models import Salesman
from apps.accounts.permissions import IsAdmin
from apps.dealers.models import Dealer, DealerOwnershipHistory
from apps.dealers.phone import normalize_phone
from apps.visits.services import normalize_gst

from .catalog_views import read_sheet

# Header text (lower-case, letters and digits only) -> dealer field. Several spellings per field, as sheets vary.
COLUMNS = {
    "name": ("name", "dealername", "dealer", "businessname", "firmname", "companyname"),
    "shop_name": ("shopname", "shop"),
    "phone": ("phone", "mobile", "phoneno", "mobileno", "phonenumber", "mobilenumber", "contactno", "contactnumber"),
    "whatsapp": ("whatsapp", "whatsappno", "whatsappnumber"),
    "address": ("address", "fulladdress", "shopaddress"),
    "city": ("city", "town"),
    "state": ("state",),
    "pincode": ("pincode", "pin", "pinno", "zip", "zipcode", "postalcode"),
    "gst_number": ("gst", "gstin", "gstno", "gstnumber"),
    "salesman": ("salesman", "owner", "assignedto", "salesmanname", "salesmanusername", "salesmanemail"),
}
LIMITS = {"name": 200, "shop_name": 200, "city": 80, "state": 80, "pincode": 10, "gst_number": 15}
REASON = "Imported"


def _key(header_cell) -> str:
    return re.sub(r"[^a-z0-9]", "", str(header_cell or "").lower())


def _text(v) -> str:
    if v is None:
        return ""
    if isinstance(v, float) and v.is_integer():  # Excel hands back 9876543210 as 9876543210.0
        v = int(v)
    return " ".join(str(v).split())


def _salesman_lookup() -> dict:
    """Active salesmen by username, email and full name (lower-case). A name two salesmen share is left out: it is ambiguous."""
    found, clashes = {}, set()
    for s in Salesman.objects.filter(is_active=True).select_related("user"):
        u = s.user
        for k in {u.username.lower(), (u.email or "").lower(), u.get_full_name().lower()} - {""}:
            if k in found and found[k] != s:
                clashes.add(k)
            found[k] = s
    return {k: v for k, v in found.items() if k not in clashes}


class DealerImportView(APIView):
    """Adds new dealers only. A phone that already belongs to a dealer is skipped, never overwritten."""

    permission_classes = [IsAdmin]
    parser_classes = [MultiPartParser, FormParser, JSONParser]

    def post(self, request):
        upload = request.FILES.get("file")
        if upload is None:
            raise ValidationError({"file": "Choose a file"})
        default_owner = None
        if request.data.get("salesman_id"):
            default_owner = Salesman.objects.filter(pk=request.data["salesman_id"], is_active=True).first()
            if default_owner is None:
                raise ValidationError({"salesman_id": "Choose an active salesman"})

        raw = read_sheet(upload)
        header = [_key(c) for c in raw[0]]
        idx = {field: next((header.index(a) for a in aliases if a in header), None) for field, aliases in COLUMNS.items()}
        if idx["name"] is None:
            raise ValidationError({"file": "The first row must have a Name column (Phone, Address, City, State, Pincode, GST and Salesman are optional)"})

        salesmen = _salesman_lookup() if idx["salesman"] is not None else {}
        taken = set(Dealer.objects.exclude(phone="").values_list("phone", flat=True))
        created, assigned, skipped, invalid = 0, 0, [], []

        for n, r in enumerate(raw[1:], start=2):
            if not any(_text(c) for c in r):
                continue
            row = {f: (_text(r[i]) if i is not None and i < len(r) else "") for f, i in idx.items()}
            problem = ""
            phone = normalize_phone(row["phone"])
            if not row["name"]:
                problem = "name is blank"
            elif row["phone"] and len(phone) != 10:
                problem = "phone is not a 10-digit number"
            elif any(len(row[f]) > m for f, m in LIMITS.items()):
                problem = "a value is too long"
            owner = default_owner
            if not problem and row["salesman"]:
                owner = salesmen.get(row["salesman"].lower())
                if owner is None:
                    problem = f'salesman "{row["salesman"]}" not found (use their username, email or full name)'
            if problem:
                invalid.append({"row": n, "reason": problem})
                continue
            if phone and phone in taken:
                skipped.append(row["name"])
                continue
            try:
                with transaction.atomic():
                    dealer = Dealer.objects.create(
                        name=row["name"], shop_name=row["shop_name"], phone=phone,
                        whatsapp=normalize_phone(row["whatsapp"]), address=row["address"], city=row["city"],
                        state=row["state"], pincode=row["pincode"], gst_number=normalize_gst(row["gst_number"]),
                        primary_salesman=owner,
                    )
                    if owner is not None:
                        DealerOwnershipHistory.objects.create(dealer=dealer, salesman=owner, reason=REASON, changed_by=request.user)
            except IntegrityError:  # the phone was taken between our check and the insert
                skipped.append(row["name"])
                continue
            if phone:
                taken.add(phone)
            created += 1
            assigned += owner is not None

        return Response({
            "created": created, "assigned": assigned, "unassigned": created - assigned,
            "skipped_count": len(skipped), "skipped_duplicates": skipped[:50],
            "invalid_count": len(invalid), "invalid_rows": invalid[:50],
        })
