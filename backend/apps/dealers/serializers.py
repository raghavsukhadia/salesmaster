from rest_framework import serializers

from .models import Dealer, DealerStatus

GSTIN = r"^(?i:\d{2}[A-Z]{5}\d{4}[A-Z][A-Z\d]Z[A-Z\d])$"


class DealerUpdateSerializer(serializers.Serializer):
    name = serializers.CharField(max_length=200, required=False)
    shop_name = serializers.CharField(max_length=200, required=False, allow_blank=True)
    phone = serializers.CharField(max_length=20, required=False, allow_blank=True)
    whatsapp = serializers.CharField(max_length=20, required=False, allow_blank=True)
    address = serializers.CharField(required=False, allow_blank=True)
    city = serializers.CharField(max_length=80, required=False, allow_blank=True)
    state = serializers.CharField(max_length=80, required=False, allow_blank=True)
    pincode = serializers.RegexField(r"^\d{6}$", required=False, allow_blank=True)
    gst_number = serializers.RegexField(
        GSTIN, required=False, allow_blank=True, error_messages={"invalid": "Enter a valid 15-character GSTIN"}
    )
    status = serializers.CharField(required=False, allow_blank=True)
    is_archived = serializers.BooleanField(required=False)

    def validate_name(self, value):
        if not value.strip():
            raise serializers.ValidationError("Name cannot be blank")
        return value.strip()

    def validate_status(self, value):
        if value and not DealerStatus.objects.filter(name=value).exists():
            raise serializers.ValidationError("Unknown status")
        return value


class TransferSerializer(serializers.Serializer):
    salesman_id = serializers.IntegerField()
    reason = serializers.CharField(max_length=200, required=False, allow_blank=True)


class GrantSerializer(serializers.Serializer):
    salesman_id = serializers.IntegerField()
