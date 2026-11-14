import os
from datetime import timedelta
from pathlib import Path

from dotenv import load_dotenv

BASE_DIR = Path(__file__).resolve().parent.parent
load_dotenv(BASE_DIR / ".env")

DEBUG = os.getenv("DJANGO_DEBUG", "false").lower() == "true"

SECRET_KEY = os.getenv("DJANGO_SECRET_KEY", "")
if not SECRET_KEY:
    if not DEBUG:
        raise RuntimeError("DJANGO_SECRET_KEY must be set when DJANGO_DEBUG is not true")
    SECRET_KEY = "dev-only-insecure-key"

ALLOWED_HOSTS = [h for h in os.getenv("DJANGO_ALLOWED_HOSTS", "localhost,127.0.0.1,testserver").split(",") if h]

INSTALLED_APPS = [
    "django.contrib.admin",
    "django.contrib.auth",
    "django.contrib.contenttypes",
    "django.contrib.sessions",
    "django.contrib.messages",
    "django.contrib.staticfiles",
    "rest_framework",
    "corsheaders",
    "django_filters",
    "apps.accounts",
    "apps.dealers",
    "apps.visits",
    "apps.field",
]

MIDDLEWARE = [
    "django.middleware.security.SecurityMiddleware",
    "corsheaders.middleware.CorsMiddleware",
    "django.contrib.sessions.middleware.SessionMiddleware",
    "django.middleware.common.CommonMiddleware",
    "django.middleware.csrf.CsrfViewMiddleware",
    "django.contrib.auth.middleware.AuthenticationMiddleware",
    "django.contrib.messages.middleware.MessageMiddleware",
    "django.middleware.clickjacking.XFrameOptionsMiddleware",
]

ROOT_URLCONF = "config.urls"

TEMPLATES = [
    {
        "BACKEND": "django.template.backends.django.DjangoTemplates",
        "DIRS": [],
        "APP_DIRS": True,
        "OPTIONS": {
            "context_processors": [
                "django.template.context_processors.request",
                "django.contrib.auth.context_processors.auth",
                "django.contrib.messages.context_processors.messages",
            ],
        },
    },
]

WSGI_APPLICATION = "config.wsgi.application"

# Postgres when DATABASE_NAME is set; SQLite fallback keeps local dev/tests simple.
if os.getenv("DATABASE_NAME"):
    DATABASES = {
        "default": {
            "ENGINE": "django.db.backends.postgresql",
            "NAME": os.environ["DATABASE_NAME"],
            "USER": os.getenv("DATABASE_USER", "postgres"),
            "PASSWORD": os.getenv("DATABASE_PASSWORD", ""),
            "HOST": os.getenv("DATABASE_HOST", "localhost"),
            "PORT": os.getenv("DATABASE_PORT", "5432"),
        }
    }
else:
    # File-backed test DB + IMMEDIATE transactions + busy timeout, so threads queue for the write lock
    # (an in-memory test DB fails concurrent writers with "table is locked"). Needed by concurrency tests.
    DATABASES = {
        "default": {
            "ENGINE": "django.db.backends.sqlite3",
            "NAME": BASE_DIR / "db.sqlite3",
            "OPTIONS": {"timeout": 30, "transaction_mode": "IMMEDIATE"},
            "TEST": {"NAME": BASE_DIR / "test_db.sqlite3"},
        }
    }

AUTH_USER_MODEL = "accounts.User"

AUTH_PASSWORD_VALIDATORS = [
    {"NAME": "django.contrib.auth.password_validation.UserAttributeSimilarityValidator"},
    {"NAME": "django.contrib.auth.password_validation.MinimumLengthValidator"},
    {"NAME": "django.contrib.auth.password_validation.CommonPasswordValidator"},
    {"NAME": "django.contrib.auth.password_validation.NumericPasswordValidator"},
]

LANGUAGE_CODE = "en-us"
TIME_ZONE = "Asia/Kolkata"
USE_I18N = True
USE_TZ = True

STATIC_URL = "static/"
DEFAULT_AUTO_FIELD = "django.db.models.BigAutoField"

CORS_ALLOWED_ORIGINS = [o for o in os.getenv("CORS_ALLOWED_ORIGINS", "http://localhost:5173").split(",") if o]

REST_FRAMEWORK = {
    "DEFAULT_AUTHENTICATION_CLASSES": ["rest_framework_simplejwt.authentication.JWTAuthentication"],
    "DEFAULT_PERMISSION_CLASSES": ["rest_framework.permissions.IsAuthenticated"],
    "DEFAULT_FILTER_BACKENDS": ["django_filters.rest_framework.DjangoFilterBackend"],
    "DEFAULT_PAGINATION_CLASS": "rest_framework.pagination.PageNumberPagination",
    "PAGE_SIZE": 25,
    "EXCEPTION_HANDLER": "apps.visits.exceptions.api_exception_handler",
    # Only views that opt in with throttle_scope use these (see apps/field/views.py).
    "DEFAULT_THROTTLE_RATES": {"field_ping": "60/min", "visit_photo": "60/min", "login_account": "10/min", "login_address": "60/min"},
}

SIMPLE_JWT = {
    "ACCESS_TOKEN_LIFETIME": timedelta(minutes=30),
    "REFRESH_TOKEN_LIFETIME": timedelta(days=7),
    # Tokens carry a hash of the password they were issued under, so changing a password (an admin reset) signs that
    # account out everywhere instead of leaving a stolen session alive for the rest of its 7 days.
    "CHECK_REVOKE_TOKEN": True,
}

# Field sales: GPS duty sessions, live tracking and geofencing. Admin-editable values (geofence radius,
# enforcement mode, ping interval, retention) live in the FieldConfig table; these are code-level limits.
FIELD_TRACKING = {
    "LIVE_MAX_AGE_S": 120,         # last fix at most this old => "live"
    "STALE_MAX_AGE_S": 900,        # older than live but within this => "stale"; beyond => "lost"
    "MAX_ACCURACY_M": 1000,        # fixes with a worse reported accuracy are rejected outright
    "GOOD_ACCURACY_M": 50,         # accuracy labels shown to managers
    "FAIR_ACCURACY_M": 150,
    "CHECKIN_MAX_ACCURACY_M": 100, # a check-in/out fix must be at least this precise to be verified
    "MAX_FUTURE_S": 60,            # tolerated (post skew-correction) timestamp ahead of the server clock
    "FRESH_FIX_S": 120,            # a check-in/out position must have been captured at most this long ago
    "CLOCK_TOLERANCE_S": 30,       # device/server clock difference below this is treated as network latency
    "MAX_BATCH": 200,              # points per upload
    "SYNC_GRACE_H": 48,            # offline points may arrive this long after the session ended
    "MAX_SESSION_H": 16,           # a forgotten duty session is closed automatically after this long
    "AUDIT_RETENTION_DAYS": 365,
    "NEARBY_RADII_KM": (1, 3, 5, 10, 20),
    "NEARBY_LIMIT": 100,
    "CONSENT_VERSION": "2026-11-v1",
}

# Visit photos. Files are private: they are served only through an authenticated view, never as public media.
MEDIA_ROOT = BASE_DIR / "media"
# Car photos a salesman must attach to every visit the app saves. Set VISIT_MIN_PHOTOS=0 to switch the rule off.
VISIT_MIN_PHOTOS = int(os.getenv("VISIT_MIN_PHOTOS", "2"))
