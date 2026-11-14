from django.urls import path

from . import photo_views, salesman_views, views

urlpatterns = [
    path("visits/record/", views.RecordVisitView.as_view()),
    path("dealers/check-duplicate/", views.DuplicateCheckView.as_view()),
    path("products/", views.ProductListView.as_view()),
    path("visits/photo-rules/", photo_views.PhotoRulesView.as_view()),
    path("visits/photos/", photo_views.PhotoUploadView.as_view()),
    path("visits/photos/<int:pk>/", photo_views.PhotoDetailView.as_view()),
    path("visits/photos/<int:pk>/image/", photo_views.PhotoImageView.as_view()),
    path("salesman/visits/", salesman_views.SalesmanVisitListView.as_view()),
    path("salesman/visits/<int:pk>/", salesman_views.SalesmanVisitDetailView.as_view()),
    path("salesman/followups/", salesman_views.SalesmanFollowupListView.as_view()),
    path("salesman/followups/summary/", salesman_views.SalesmanFollowupSummaryView.as_view()),
    path("salesman/followups/<int:pk>/<str:action>/", salesman_views.SalesmanFollowupActionView.as_view()),
]
