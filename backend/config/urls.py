from django.contrib import admin
from django.urls import include, path
from rest_framework_simplejwt.views import TokenRefreshView

from apps.accounts.views import LoginView

urlpatterns = [
    path("admin/", admin.site.urls),
    path("api/auth/token/", LoginView.as_view()),
    path("api/auth/token/refresh/", TokenRefreshView.as_view()),
    path("api/", include("apps.accounts.urls")),
    path("api/", include("apps.visits.urls")),
    path("api/", include("apps.dealers.urls")),
    path("api/", include("apps.management.urls")),
    path("api/", include("apps.field.urls")),
    path("api/", include("apps.reports.urls")),
]
