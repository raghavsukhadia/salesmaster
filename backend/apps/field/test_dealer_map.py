import pytest
from django.utils import timezone
from rest_framework.test import APIClient

from apps.accounts.models import Role
from apps.dealers.models import Dealer
from apps.field.helpers import api, make_dealer, make_user


pytestmark = pytest.mark.django_db
URL = "/api/management/field/dealer-markers/"


def test_all_saved_dealers_appear_without_a_salesman_or_radius_or_page_limit():
    # More than both the ordinary list page (25) and nearby-search limit (100).
    Dealer.objects.bulk_create([
        Dealer(name=f"Dealer {i}", latitude="18.5204", longitude="73.8567") for i in range(105)
    ])
    far = make_dealer("Delhi dealer", 28.6139, 77.2090, city="Delhi", state="Delhi")
    data = api(make_user("admin", Role.ADMIN)).get(URL).data
    assert data["total"] == data["located"] == len(data["results"]) == 106
    assert data["missing_location"] == 0
    assert far.id in {row["id"] for row in data["results"]}


def test_pins_use_saved_coordinates_and_distinguish_same_name_dealers():
    pune = make_dealer("Sharma Auto", 18.5204, 73.8567, city="Pune", phone="9111111111")
    mumbai = make_dealer("Sharma Auto", 19.0760, 72.8777, city="Mumbai", phone="9222222222")
    pune.location_verified_at = timezone.now()
    pune.save(update_fields=["location_verified_at"])
    rows = api(make_user("manager", Role.MANAGER)).get(URL).data["results"]
    assert [(row["id"], row["name"], row["latitude"], row["location_verified"]) for row in rows] == [
        (pune.id, "Sharma Auto", 18.5204, True), (mumbai.id, "Sharma Auto", 19.076, False),
    ]


def test_missing_invalid_and_archived_locations_never_create_fake_pins():
    make_dealer("Name only", city="Pune")
    make_dealer("Partial", lat=18.52)
    make_dealer("Placeholder", 0, 0)
    make_dealer("Bad latitude", 91, 73)
    make_dealer("Bad longitude", 18, 181)
    make_dealer("Archived", 18.52, 73.85, is_archived=True)
    data = api(make_user("admin", Role.ADMIN)).get(URL).data
    assert data == {"total": 5, "located": 0, "missing_location": 5, "results": []}


def test_saved_location_updates_are_visible_on_the_next_map_request():
    dealer = make_dealer("New dealer")
    client = api(make_user("admin", Role.ADMIN))
    assert client.get(URL).data["missing_location"] == 1
    response = client.put(f"/api/management/dealers/{dealer.id}/location/", {
        "latitude": 18.5204, "longitude": 73.8567, "source": "map_pin", "verified": True,
    }, format="json")
    assert response.status_code == 200
    [pin] = client.get(URL).data["results"]
    assert (pin["id"], pin["latitude"], pin["longitude"]) == (dealer.id, 18.5204, 73.8567)


def test_dealer_map_is_management_only():
    assert APIClient().get(URL).status_code == 401
    assert api(make_user("salesman")).get(URL).status_code == 403
    assert api(make_user("manager", Role.MANAGER)).get(URL).status_code == 200
    assert api(make_user("admin", Role.ADMIN)).get(URL).status_code == 200
