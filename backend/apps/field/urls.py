from django.urls import path

from . import mgmt_views as m
from . import views as v

urlpatterns = [
    # Salesman: declared duty, GPS upload, nearby dealers.
    path("field/session/", v.SessionView.as_view()),
    path("field/session/start/", v.SessionStartView.as_view()),
    path("field/session/end/", v.SessionEndView.as_view()),
    path("field/locations/", v.LocationBatchView.as_view()),
    path("field/nearby-dealers/", v.NearbyDealersView.as_view()),
    path("field/today/", v.TodayView.as_view()),
    path("field/checkins/", v.CheckInView.as_view()),
    path("field/checkins/<int:pk>/check-out/", v.CheckOutView.as_view()),
    path("field/stops/<int:pk>/skip/", v.SkipStopView.as_view()),
    # Management: live map, route history, searches, dealer location master, configuration, audit.
    path("management/field/live/", m.LiveMapView.as_view()),
    path("management/field/dealer-markers/", m.DealerMapView.as_view()),
    path("management/field/salesmen/<int:pk>/track/", m.TrackView.as_view()),
    path("management/field/salesmen/<int:pk>/end-session/", m.ForceEndSessionView.as_view()),
    path("management/field/nearby-dealers/", m.NearbyView.as_view()),
    path("management/field/dealers/<int:pk>/nearest-salesmen/", m.NearestSalesmenView.as_view()),
    path("management/field/dealer-locations/", m.DealerLocationsListView.as_view()),
    path("management/field/config/", m.ConfigView.as_view()),
    path("management/field/beats/", m.BeatPlanView.as_view()),
    path("management/field/beats/dealer-options/", m.BeatDealerOptionsView.as_view()),
    path("management/field/checkins/", m.CheckInListView.as_view()),
    path("management/field/audit/", m.AuditLogView.as_view()),
    path("management/dealers/<int:pk>/location/", m.DealerLocationView.as_view()),
    path("management/dealers/<int:pk>/location/verify/", m.DealerLocationVerifyView.as_view()),
]
