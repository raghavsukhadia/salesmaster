from django.contrib.auth.password_validation import validate_password
from django.core.exceptions import ValidationError as DjangoValidationError
from rest_framework import serializers
from rest_framework_simplejwt.serializers import TokenObtainPairSerializer

from .models import User


class ChangePasswordSerializer(serializers.Serializer):
    """A signed-in user choosing a new password for themselves. Needs the current one, so a borrowed phone or a stolen
    session cannot lock the real owner out. The new one must pass the same checks as an admin-set password."""

    current_password = serializers.CharField(write_only=True, trim_whitespace=False, max_length=128)
    new_password = serializers.CharField(write_only=True, trim_whitespace=False, max_length=128)

    def validate_current_password(self, value):
        if not self.context["request"].user.check_password(value):
            raise serializers.ValidationError("Your current password is not correct.")
        return value

    def validate(self, attrs):
        if attrs["new_password"] == attrs["current_password"]:
            raise serializers.ValidationError({"new_password": "Choose a password different from your current one."})
        try:
            validate_password(attrs["new_password"], self.context["request"].user)
        except DjangoValidationError as e:
            raise serializers.ValidationError({"new_password": list(e.messages)})
        return attrs


class LoginSerializer(TokenObtainPairSerializer):
    """The stock JWT sign-in, but the "username" box also accepts the account's email address.

    An email is only turned into a username when that is unambiguous: no account already uses the text as its
    username, and exactly one active account has that email. Anything else falls through to a normal failed
    sign-in, so an address shared by two people can never sign either of them in as the other.
    """

    def validate(self, attrs):
        ident = str(attrs.get(self.username_field, "")).strip()
        if "@" in ident and not User.objects.filter(username=ident).exists():
            owners = list(User.objects.filter(email__iexact=ident, is_active=True).values_list("username", flat=True)[:2])
            if len(owners) == 1:
                attrs[self.username_field] = owners[0]
        return super().validate(attrs)
