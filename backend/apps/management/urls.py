from django.urls import path

from . import catalog_views as cv
from . import dealer_import as di
from . import detail_views as dv
from . import salesman_views as sv
from . import scope_views as sc
from . import views

urlpatterns = [
    path("management/products/", cv.ProductsView.as_view()),
    path("management/products/import/", cv.ProductImportView.as_view()),
    path("management/products/<int:pk>/", cv.ProductDetailView.as_view()),
    path("management/scope-options/", sc.ScopeOptionsView.as_view()),
    path("management/areas/", sc.OwnerAreasView.as_view()),
    path("management/transfers/preview/", sc.TransferPreviewView.as_view()),
    path("management/transfers/", sc.TransferExecuteView.as_view()),
    path("management/ownership-cleanup/", sc.CleanupView.as_view()),
    path("management/ownership-cleanup/assign/", sc.CleanupAssignView.as_view()),
    path("management/access-grants/", sc.AccessGrantsView.as_view()),
    path("management/access-grants/preview/", sc.AccessGrantPreviewView.as_view()),
    path("management/access-grants/<int:pk>/revoke/", sc.AccessGrantRevokeView.as_view()),
    path("management/visits/<int:pk>/", dv.ManagementVisitDetailView.as_view()),
    path("management/followups/<int:pk>/", dv.ManagementFollowupDetailView.as_view()),
    path("management/salesmen/create/", sv.SalesmanCreateView.as_view()),
    path("management/salesmen/<int:pk>/", sv.SalesmanDetailView.as_view()),
    path("management/salesmen/<int:pk>/reset-password/", sv.ResetPasswordView.as_view()),
    path("management/salesmen/<int:pk>/territories/", sv.TerritoriesView.as_view()),
    path("management/salesmen/<int:pk>/assign-dealers/", sv.AssignDealersView.as_view()),
    path("management/salesmen/<int:pk>/offboard/", sv.OffboardView.as_view()),
    path("management/salesmen/<int:pk>/visits/", sv.SalesmanVisitsView.as_view()),
    path("management/salesmen/<int:pk>/dealers/", sv.SalesmanDealersView.as_view()),
    path("management/dashboard/", views.DashboardView.as_view()),
    path("management/dealers/import/", di.DealerImportView.as_view()),
    path("management/dealers/", views.DealersView.as_view()),
    path("management/salesmen/", views.SalesmenView.as_view()),
    path("management/visits/", views.VisitsView.as_view()),
    path("management/followups/", views.FollowupsView.as_view()),
]
