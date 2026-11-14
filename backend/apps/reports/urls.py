from django.urls import path

from . import views

urlpatterns = [
    path("reports/options/", views.OptionsView.as_view()),
    path("reports/dealer-options/", views.DealerOptionsView.as_view()),
    path("reports/<slug:slug>/", views.ReportView.as_view()),
    path("reports/<slug:slug>/export/", views.ExportView.as_view()),
    path("reports/<slug:slug>/<int:pk>/", views.ReportView.as_view()),
    path("reports/<slug:slug>/<int:pk>/export/", views.ExportView.as_view()),
]
