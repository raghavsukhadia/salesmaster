import csv
import io

from django.db import IntegrityError, transaction
from django.db.models import Q
from django.db.models.functions import Lower
from rest_framework import serializers
from rest_framework.exceptions import NotFound, ValidationError
from rest_framework.parsers import FormParser, JSONParser, MultiPartParser
from rest_framework.response import Response
from rest_framework.views import APIView

from apps.accounts.permissions import IsManagement
from apps.visits.models import Product

from .views import PAGE_SIZE, paginate

DUPLICATE = "A product with this name already exists"
MAX_IMPORT_BYTES = 2 * 1024 * 1024
MAX_IMPORT_ROWS = 2000


class ProductSerializer(serializers.Serializer):
    name = serializers.CharField(max_length=200)
    category = serializers.CharField(max_length=100, required=False, allow_blank=True)
    description = serializers.CharField(required=False, allow_blank=True)
    is_active = serializers.BooleanField(required=False)

    def validate_name(self, value):
        value = " ".join(value.split())
        if not value:
            raise serializers.ValidationError("Name cannot be blank")
        return value


def row(p: Product):
    return {"id": p.id, "name": p.name, "category": p.category, "description": p.description,
            "is_active": p.is_active, "updated_at": p.updated_at}


def name_taken(name, exclude_pk=None) -> bool:
    qs = Product.objects.annotate(n=Lower("name")).filter(n=name.lower())
    return qs.exclude(pk=exclude_pk).exists() if exclude_pk else qs.exists()


class ProductsView(APIView):
    permission_classes = [IsManagement]

    def get(self, request):
        p = request.query_params
        qs = Product.objects.all()
        q = p.get("q", "").strip()
        if q:
            qs = qs.filter(Q(name__icontains=q) | Q(category__icontains=q) | Q(description__icontains=q))
        if p.get("status") == "active":
            qs = qs.filter(is_active=True)
        elif p.get("status") == "inactive":
            qs = qs.filter(is_active=False)
        count, page = paginate(request, qs.order_by("name", "id"))
        total = Product.objects.count()
        active = Product.objects.filter(is_active=True).count()
        return Response({
            "summary": {"total": total, "active": active, "inactive": total - active},
            "count": count, "page_size": PAGE_SIZE,
            "results": [row(x) for x in page],
        })

    def post(self, request):
        s = ProductSerializer(data=request.data)
        s.is_valid(raise_exception=True)
        v = s.validated_data
        if name_taken(v["name"]):
            raise ValidationError({"name": DUPLICATE})
        try:
            with transaction.atomic():
                p = Product.objects.create(
                    name=v["name"], category=v.get("category", "").strip(),
                    description=v.get("description", "").strip(), is_active=v.get("is_active", True),
                )
        except IntegrityError:
            raise ValidationError({"name": DUPLICATE})
        return Response(row(p), status=201)


class ProductDetailView(APIView):
    """Products are deactivated, never deleted: order lines and interests reference them."""

    permission_classes = [IsManagement]

    def patch(self, request, pk):
        p = Product.objects.filter(pk=pk).first()
        if p is None:
            raise NotFound("Product not found")
        s = ProductSerializer(data=request.data, partial=True)
        s.is_valid(raise_exception=True)
        v = s.validated_data
        if "name" in v and name_taken(v["name"], exclude_pk=p.pk):
            raise ValidationError({"name": DUPLICATE})
        for f in ("name", "category", "description"):
            if f in v:
                setattr(p, f, v[f].strip())
        if "is_active" in v:
            p.is_active = v["is_active"]
        try:
            with transaction.atomic():
                p.save()
        except IntegrityError:
            raise ValidationError({"name": DUPLICATE})
        return Response(row(p))


def read_sheet(upload):
    """Raw rows (header first) from an uploaded .xlsx or .csv. Size and format are checked; the caller checks columns."""
    data = upload.read()
    if len(data) > MAX_IMPORT_BYTES:
        raise ValidationError({"file": "File is too large (2 MB max)"})
    name = (upload.name or "").lower()
    if name.endswith(".xlsx"):
        from openpyxl import load_workbook

        try:
            ws = load_workbook(io.BytesIO(data), read_only=True, data_only=True).active
            raw = [list(r) for r in ws.iter_rows(values_only=True)]
        except Exception:
            raise ValidationError({"file": "Could not read this Excel file"})
    elif name.endswith(".csv"):
        try:
            raw = list(csv.reader(io.StringIO(data.decode("utf-8-sig"))))
        except UnicodeDecodeError:
            raise ValidationError({"file": "CSV must be UTF-8"})
    else:
        raise ValidationError({"file": "Upload an .xlsx or .csv file"})
    if not raw:
        raise ValidationError({"file": "The file is empty"})
    if len(raw) - 1 > MAX_IMPORT_ROWS:
        raise ValidationError({"file": f"Too many rows ({MAX_IMPORT_ROWS} max)"})
    return raw


def _read_rows(upload):
    """(name, category, description) per row of an .xlsx or .csv with a header row."""
    raw = read_sheet(upload)
    header = [str(c or "").strip().lower() for c in raw[0]]
    if "name" not in header:
        raise ValidationError({"file": "The first row must have a Name column (Category and Description are optional)"})
    idx = {k: header.index(k) if k in header else None for k in ("name", "category", "description")}
    body = raw[1:]

    def cell(r, k):
        i = idx[k]
        return " ".join(str(r[i]).split()) if i is not None and i < len(r) and r[i] is not None else ""

    return [(cell(r, "name"), cell(r, "category"), cell(r, "description")) for r in body if any(r)]


class ProductImportView(APIView):
    """Adds new products only. Existing names are skipped, never overwritten."""

    permission_classes = [IsManagement]
    parser_classes = [MultiPartParser, FormParser, JSONParser]

    def post(self, request):
        upload = request.FILES.get("file")
        if upload is None:
            raise ValidationError({"file": "Choose a file"})
        rows = _read_rows(upload)
        existing = {n.lower() for n in Product.objects.values_list("name", flat=True)}
        created, skipped, invalid = 0, [], []
        with transaction.atomic():
            for n, (name, category, desc) in enumerate(rows, start=2):
                if not name or len(name) > 200 or len(category) > 100:
                    invalid.append(n)
                elif name.lower() in existing:
                    skipped.append(name)
                else:
                    Product.objects.create(name=name, category=category, description=desc)
                    existing.add(name.lower())
                    created += 1
        return Response({"created": created, "skipped_duplicates": skipped[:50], "skipped_count": len(skipped),
                         "invalid_rows": invalid[:50], "invalid_count": len(invalid)})
