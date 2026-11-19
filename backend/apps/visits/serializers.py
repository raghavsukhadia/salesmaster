from datetime import timedelta

from django.utils import timezone
from rest_framework import serializers

from .models import Followup
from .timing import check_time_not_past

# Units a salesman can pick for an order line. VisitOrderItem.unit is a free 10-char column; the API keeps it to a known list.
ORDER_UNITS = ("pcs", "box", "roll", "set", "pair", "sq ft", "sq m", "mtr", "kg", "ltr")


class NewDealerSerializer(serializers.Serializer):
    name = serializers.CharField(max_length=200)
    shop_name = serializers.CharField(max_length=200, required=False, allow_blank=True)
    phone = serializers.CharField(max_length=20, required=False, allow_blank=True)
    whatsapp = serializers.CharField(max_length=20, required=False, allow_blank=True)
    address = serializers.CharField(required=False, allow_blank=True)
    city = serializers.CharField(max_length=80, required=False, allow_blank=True)
    state = serializers.CharField(max_length=80, required=False, allow_blank=True)
    pincode = serializers.RegexField(r"^\d{6}$", required=False, allow_blank=True)
    gst_number = serializers.RegexField(
        r"^(?i:\d{2}[A-Z]{5}\d{4}[A-Z][A-Z\d]Z[A-Z\d])$", required=False, allow_blank=True,
        error_messages={"invalid": "Enter a valid 15-character GSTIN"},
    )
    contact_name = serializers.CharField(max_length=120, required=False, allow_blank=True)
    # "Detect current location" on the new-dealer form: the salesman's GPS fix at the shop. Stored as an UNVERIFIED
    # dealer location (source gps_checkin); only management can verify it in the location master.
    latitude = serializers.DecimalField(max_digits=9, decimal_places=6, min_value=-90, max_value=90, required=False)
    longitude = serializers.DecimalField(max_digits=9, decimal_places=6, min_value=-180, max_value=180, required=False)
    location_accuracy_m = serializers.FloatField(min_value=0, max_value=100000, required=False)

    def validate(self, attrs):
        if not (attrs.get("phone") or attrs.get("whatsapp") or attrs.get("gst_number") or attrs.get("city")):
            raise serializers.ValidationError("Provide a phone, WhatsApp, GST number or city to identify the dealer")
        if (attrs.get("latitude") is None) != (attrs.get("longitude") is None):
            raise serializers.ValidationError("latitude and longitude must be provided together")
        return attrs


class OrderItemSerializer(serializers.Serializer):
    product_id = serializers.IntegerField(required=False, allow_null=True)
    product_name = serializers.CharField(max_length=200, required=False, allow_blank=True)
    quantity = serializers.IntegerField(min_value=1, max_value=100000)
    unit = serializers.ChoiceField(choices=ORDER_UNITS, required=False, default="pcs")
    # Price per unit in rupees. 0 means "not priced yet": the order is still recorded.
    unit_price = serializers.DecimalField(max_digits=12, decimal_places=2, min_value=0, required=False, default=0)

    def validate(self, attrs):
        if not attrs.get("product_id") and not attrs.get("product_name", "").strip():
            raise serializers.ValidationError("Provide a product_id or a product_name")
        return attrs


class FollowupSerializer(serializers.Serializer):
    due_date = serializers.DateField()
    due_time = serializers.TimeField(required=False, allow_null=True)
    priority = serializers.ChoiceField(choices=Followup.Priority.choices, required=False)
    notes = serializers.CharField(required=False, allow_blank=True)
    # What the salesman will do ("call_dealer", ..., "other"). Optional here: check-ins and older clients send none.
    action = serializers.ChoiceField(choices=Followup.Action.choices, required=False)
    action_text = serializers.CharField(max_length=200, required=False, allow_blank=True)

    def validate_due_date(self, value):
        if value < timezone.localdate():
            raise serializers.ValidationError("Follow-up date cannot be in the past")
        return value

    def validate(self, attrs):
        check_time_not_past(attrs["due_date"], attrs.get("due_time"))
        text = attrs.get("action_text", "").strip()
        if attrs.get("action") == Followup.Action.OTHER:
            if not text:
                raise serializers.ValidationError({"action_text": "Say what you will do"})
            attrs["action_text"] = text
        else:
            attrs.pop("action_text", None)  # only "other" carries free text
        return attrs


class FollowupCreateSerializer(FollowupSerializer):
    """A reminder created on its own, not as part of recording a visit."""

    dealer_id = serializers.IntegerField()
    notes = serializers.CharField(required=False, allow_blank=True, max_length=2000)

    def validate_due_date(self, value):
        value = super().validate_due_date(value)
        if value > timezone.localdate() + timedelta(days=365):
            raise serializers.ValidationError("Choose a date within the next year")
        return value


class RecordVisitSerializer(serializers.Serializer):
    client_request_id = serializers.UUIDField(required=False)
    dealer_id = serializers.IntegerField(required=False)
    new_dealer = NewDealerSerializer(required=False)
    visited_at = serializers.DateTimeField(required=False)
    latitude = serializers.DecimalField(max_digits=9, decimal_places=6, min_value=-90, max_value=90, required=False)
    longitude = serializers.DecimalField(max_digits=9, decimal_places=6, min_value=-180, max_value=180, required=False)
    notes = serializers.CharField(required=False, allow_blank=True, max_length=5000)
    has_order = serializers.BooleanField(default=False)
    order_items = OrderItemSerializer(many=True, required=False, max_length=50)
    followup = FollowupSerializer(required=False)
    # Staged photos (POST /api/visits/photos/) to attach; the server enforces the minimum number of car photos.
    photo_ids = serializers.ListField(child=serializers.IntegerField(), required=False, max_length=12)

    def validate_visited_at(self, value):
        if value > timezone.now() + timedelta(minutes=5):
            raise serializers.ValidationError("Visit time cannot be in the future")
        return value

    def validate(self, attrs):
        if bool(attrs.get("dealer_id")) == bool(attrs.get("new_dealer")):
            raise serializers.ValidationError("Provide exactly one of dealer_id or new_dealer")
        # A new dealer is only created with the shop's GPS location, taken by the salesman at the shop.
        new = attrs.get("new_dealer")
        if new and (new.get("latitude") is None or new.get("longitude") is None):
            raise serializers.ValidationError({"new_dealer": {"location": "Detect the shop location before saving a new dealer."}})
        if (attrs.get("latitude") is None) != (attrs.get("longitude") is None):
            raise serializers.ValidationError("latitude and longitude must be provided together")
        has_items = bool(attrs.get("order_items"))
        if attrs.get("has_order") and not has_items:
            raise serializers.ValidationError({"order_items": "Add at least one item for an order"})
        if not attrs.get("has_order"):
            attrs["order_items"] = []
        return attrs


class DuplicateCheckSerializer(serializers.Serializer):
    name = serializers.CharField(max_length=200, required=False, allow_blank=True)
    phone = serializers.CharField(max_length=20, required=False, allow_blank=True)
    whatsapp = serializers.CharField(max_length=20, required=False, allow_blank=True)
    gst_number = serializers.CharField(max_length=15, required=False, allow_blank=True)
    city = serializers.CharField(max_length=80, required=False, allow_blank=True)


class FollowupActionSerializer(serializers.Serializer):
    outcome = serializers.ChoiceField(choices=Followup.Outcome.choices, required=False)
    notes = serializers.CharField(max_length=2000, required=False, allow_blank=True)
    due_date = serializers.DateField(required=False)
    due_time = serializers.TimeField(required=False, allow_null=True)
    priority = serializers.ChoiceField(choices=Followup.Priority.choices, required=False)
