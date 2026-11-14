from django.urls import path

from . import views

urlpatterns = [
    path("me/", views.MeView.as_view()),
    path("salesman/dealers/", views.SalesmanDealersView.as_view()),
    path("management/ping/", views.ManagementPingView.as_view()),
    path("admin-area/ping/", views.AdminPingView.as_view()),
]
