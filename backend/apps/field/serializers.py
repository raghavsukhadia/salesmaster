import math

from django.conf import settings
from rest_framework import serializers

from apps.dealers.models import Dealer

from .geo import valid_coordinate
from apps.visits.serializers import FollowupSerializer, OrderItemSerializer

from .models import DealerCheckIn, FieldConfig


class FiniteFloat(serializers.FloatField):
    """FloatField that also refuses NaN/Infinity, which slip past min/max validators (NaN compares False)."""

    def to_internal_value(self, data):
        value = super().to_internal_value(data)
        if not math.isfinite(value):
            self.fail("invalid")
        return value


class Latitude(FiniteFloat):
    def __init__(self, **kw):
        super().__init__(min_value=-90, max_value=90, **kw)


class Longitude(FiniteFloat):
    def __init__(self, **kw):
        super().__init__(min_value=-180, max_value=180, **kw)


def _tune(key):
    return settings.FIELD_TRACKING[key]


class ConsentSerializer(serializers.Serializer):
    consent = serializers.BooleanField()
    consent_version = serializers.CharField(max_length=32)


class PointSerializer(serializers.Serializer):
    client_point_id = serializers.UUIDField()
    latitude = Latitude()
    longitude = Longitude()
    accuracy_m = FiniteFloat(min_value=0, max_value=1_000_000)
    captured_at = serializers.DateTimeField()


class PointBatchSerializer(serializers.Serializer):
    sent_at = serializers.DateTimeField(required=False)  # the device clock when it sent this batch
    points = PointSerializer(many=True, allow_empty=False, max_length=_tune("MAX_BATCH"))


class NearbyQuerySerializer(serializers.Serializer):
    latitude = Latitude()
    longitude = Longitude()
    radius_km = serializers.IntegerField(required=False, default=5)
    verified_only = serializers.BooleanField(required=False, default=False)

    def validate_radius_km(self, value):
        radii = tuple(_tune("NEARBY_RADII_KM"))
        if value not in radii:
            raise serializers.ValidationError(f"radius_km must be one of {', '.join(map(str, radii))}")
        return value

    def validate(self, attrs):
        if not valid_coordinate(attrs["latitude"], attrs["longitude"]):
            raise serializers.ValidationError("Not a usable location")
        return attrs


class DealerLocationSerializer(serializers.Serializer):
    SOURCES = [Dealer.LocationSource.MANUAL, Dealer.LocationSource.MAP_PIN,
               Dealer.LocationSource.GEOCODED, Dealer.LocationSource.IMPORT]

    latitude = Latitude()
    longitude = Longitude()
    accuracy_m = FiniteFloat(min_value=0, max_value=1_000_000, required=False, allow_null=True)
    source = serializers.ChoiceField(choices=SOURCES, default=Dealer.LocationSource.MANUAL)
    verified = serializers.BooleanField(default=False)
    geofence_radius_m = serializers.IntegerField(min_value=20, max_value=2000, required=False, allow_null=True)

    def validate(self, attrs):
        if not valid_coordinate(attrs["latitude"], attrs["longitude"]):
            raise serializers.ValidationError("Not a usable location (0, 0 is treated as unset)")
        return attrs


class ConfigSerializer(serializers.ModelSerializer):
    default_geofence_m = serializers.IntegerField(min_value=20, max_value=2000)
    ping_interval_s = serializers.IntegerField(min_value=10, max_value=600)
    retention_days = serializers.IntegerField(min_value=7, max_value=730)

    class Meta:
        model = FieldConfig
        fields = ["default_geofence_m", "geofence_mode", "ping_interval_s", "retention_days"]


class FixSerializer(serializers.Serializer):
    """One GPS reading taken for a check-in or check-out."""

    latitude = Latitude()
    longitude = Longitude()
    accuracy_m = FiniteFloat(min_value=0, max_value=1_000_000)
    captured_at = serializers.DateTimeField()


class CheckInSerializer(serializers.Serializer):
    dealer_id = serializers.IntegerField()
    position = FixSerializer()
    sent_at = serializers.DateTimeField(required=False)
    reason = serializers.CharField(max_length=300, required=False, allow_blank=True)
    client_request_id = serializers.UUIDField(required=False)


class CheckOutSerializer(serializers.Serializer):
    position = FixSerializer()
    sent_at = serializers.DateTimeField(required=False)
    reason = serializers.CharField(max_length=300, required=False, allow_blank=True)
    client_request_id = serializers.UUIDField(required=False)
    outcome = serializers.ChoiceField(choices=DealerCheckIn.Outcome.choices)
    notes = serializers.CharField(max_length=5000, required=False, allow_blank=True)
    has_order = serializers.BooleanField(default=False)
    order_items = OrderItemSerializer(many=True, required=False, max_length=50)
    followup = FollowupSerializer(required=False)
    photo_ids = serializers.ListField(child=serializers.IntegerField(), required=False, max_length=12)

    def validate(self, attrs):
        has_items = bool(attrs.get("order_items"))
        if attrs["has_order"] and not has_items:
            raise serializers.ValidationError({"order_items": "Add at least one item for an order"})
        if not attrs["has_order"]:
            attrs["order_items"] = []
        ordered = attrs["outcome"] == DealerCheckIn.Outcome.ORDER_TAKEN
        if ordered != attrs["has_order"]:
            raise serializers.ValidationError({"outcome": "Choose \"Order taken\" exactly when you are recording order items"})
        return attrs


class ReasonSerializer(serializers.Serializer):
    reason = serializers.CharField(max_length=200, required=False, allow_blank=True)


class BeatStopInputSerializer(serializers.Serializer):
    dealer_id = serializers.IntegerField()
    note = serializers.CharField(max_length=200, required=False, allow_blank=True)


class BeatSaveSerializer(serializers.Serializer):
    salesman_id = serializers.IntegerField()
    date = serializers.DateField()
    note = serializers.CharField(max_length=300, required=False, allow_blank=True)
    stops = BeatStopInputSerializer(many=True, allow_empty=True, max_length=60)
