"""Cloud Run settings. Local development and tests keep using config.settings.

All env parsing (secret key, hosts, FRONTEND_URLS, Cloud SQL socket) lives in config.settings; this file only
fails fast when production values are missing and adds HTTPS hardening and private GCS storage for visit photos
(Cloud Run's disk is ephemeral, so uploaded files must not live in MEDIA_ROOT).
"""
from django.core.exceptions import ImproperlyConfigured

from .settings import *  # noqa: F403


def required(name):
    value = os.getenv(name, "").strip()  # noqa: F405
    if not value:
        raise ImproperlyConfigured(f"{name} must be configured for Cloud Run")
    return value


for name in ("DJANGO_SECRET_KEY", "ALLOWED_HOSTS", "FRONTEND_URLS",
             "INSTANCE_CONNECTION_NAME", "DB_NAME", "DB_USER", "DB_PASSWORD"):
    required(name)

DEBUG = False
SECURE_PROXY_SSL_HEADER = ("HTTP_X_FORWARDED_PROTO", "https")
SECURE_SSL_REDIRECT = True
SESSION_COOKIE_SECURE = True
CSRF_COOKIE_SECURE = True
SECURE_HSTS_SECONDS = 3600

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
