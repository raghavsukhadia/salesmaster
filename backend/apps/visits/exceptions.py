from rest_framework import status
from rest_framework.exceptions import APIException
from rest_framework.views import exception_handler


class DealerNotAvailable(APIException):
    """Never reveals names or owners of dealers the user cannot access."""

    status_code = status.HTTP_409_CONFLICT
    default_code = "dealer_not_available"
    default_detail = "This dealer is not available to you"


class DuplicateDealer(APIException):
    status_code = status.HTTP_409_CONFLICT
    default_code = "duplicate_dealer"
    default_detail = "A dealer with these details already exists"

    def __init__(self, dealer):
        super().__init__()
        self.payload = {
            "detail": self.default_detail,
            "code": self.default_code,
            "dealer": {"id": dealer.id, "name": dealer.name, "city": dealer.city},
        }


class NoSalesmanProfile(APIException):
    status_code = status.HTTP_403_FORBIDDEN
    default_code = "no_salesman_profile"
    default_detail = "No active salesman profile for this user"


def api_exception_handler(exc, context):
    response = exception_handler(exc, context)
    if response is not None and isinstance(exc, DuplicateDealer):
        response.data = exc.payload
    return response
