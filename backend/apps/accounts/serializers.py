from rest_framework_simplejwt.serializers import TokenObtainPairSerializer

from .models import User


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
