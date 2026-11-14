from rest_framework.throttling import SimpleRateThrottle


class LoginAccountThrottle(SimpleRateThrottle):
    """Limits guesses against one account, wherever they come from.

    Keyed on the username alone, not on the client address: behind a proxy the address is easy to rotate with a forged
    X-Forwarded-For header, and a password guess does not care which address it came from. The price is that someone
    can keep a named account's sign-in blocked by hammering it; the window is a minute, and an admin can still reset it.
    """

    scope = "login_account"

    def get_cache_key(self, request, view):
        username = str(request.data.get("username", "")).strip().lower()[:150]
        if not username:
            return None  # an empty username cannot be a guess at any account; the serializer rejects it anyway
        return self.cache_format % {"scope": self.scope, "ident": username}


class LoginAddressThrottle(SimpleRateThrottle):
    """A generous cap per address, so one machine cannot walk through many usernames. Shared office Wi-Fi stays well under it."""

    scope = "login_address"

    def get_cache_key(self, request, view):
        return self.cache_format % {"scope": self.scope, "ident": self.get_ident(request)}
