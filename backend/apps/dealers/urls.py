from django.urls import path

from . import salesman_views, views

urlpatterns = [
    path("salesman/areas/", salesman_views.SalesmanAreasView.as_view()),
    path("salesman/dealer-list/", salesman_views.SalesmanDealerListView.as_view()),
    path("salesman/cities/", salesman_views.SalesmanCitiesView.as_view()),
    path("dealers/<int:pk>/", views.DealerDetailView.as_view()),
    path("dealers/<int:pk>/transfer/", views.TransferView.as_view()),
    path("dealers/<int:pk>/grants/", views.GrantListView.as_view()),
    path("dealers/<int:pk>/grants/<int:grant_id>/revoke/", views.GrantRevokeView.as_view()),
    path("dealers/<int:pk>/<str:tab>/", views.DealerTabView.as_view()),
]
