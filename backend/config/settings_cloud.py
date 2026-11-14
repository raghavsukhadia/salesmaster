"""Cloud Run settings. Local development and tests keep using config.settings."""
from django.core.exceptions import ImproperlyConfigured

from .settings import *  # noqa: F403


def required(name):
    value = os.getenv(name, "").strip()
    if not value:
        raise ImproperlyConfigured(f"{name} must be configured for Cloud Run")
    return value


DEBUG = False
SECRET_KEY = required("DJANGO_SECRET_KEY")
for name in ("DATABASE_NAME", "DATABASE_USER", "DATABASE_PASSWORD", "DATABASE_HOST"):
    required(name)
ALLOWED_HOSTS = [value.strip() for value in required("DJANGO_ALLOWED_HOSTS").split(",") if value.strip()]
CORS_ALLOWED_ORIGINS = [value.strip() for value in required("CORS_ALLOWED_ORIGINS").split(",") if value.strip()]
CORS_EXPOSE_HEADERS = ["Content-Disposition"]
CSRF_TRUSTED_ORIGINS = [
    value.strip() for value in os.getenv("CSRF_TRUSTED_ORIGINS", "").split(",") if value.strip()
]
SECURE_PROXY_SSL_HEADER = ("HTTP_X_FORWARDED_PROTO", "https")
SECURE_SSL_REDIRECT = True
SESSION_COOKIE_SECURE = True
CSRF_COOKIE_SECURE = True
SECURE_HSTS_SECONDS = 3600

STATIC_ROOT = BASE_DIR / "staticfiles"
MIDDLEWARE = [MIDDLEWARE[0], "whitenoise.middleware.WhiteNoiseMiddleware", *MIDDLEWARE[1:]]
STORAGES = {
    "default": {
        "BACKEND": "storages.backends.gcloud.GoogleCloudStorage",
        "OPTIONS": {
            "bucket_name": required("GS_BUCKET_NAME"),
            "default_acl": None,
            "file_overwrite": False,
        },
    },
    "staticfiles": {"BACKEND": "whitenoise.storage.CompressedManifestStaticFilesStorage"},
}
