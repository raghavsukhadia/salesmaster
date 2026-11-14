from django.http import FileResponse
from rest_framework import status
from rest_framework.exceptions import NotFound
from rest_framework.parsers import FormParser, MultiPartParser
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response
from rest_framework.throttling import ScopedRateThrottle
from rest_framework.views import APIView

from apps.accounts.permissions import IsSalesman

from . import photos
from .models import VisitPhoto
from .services import get_salesman


def _row(p: VisitPhoto) -> dict:
    return {"id": p.id, "kind": p.kind, "url": photos.photo_url(p.id), "width": p.width, "height": p.height}


class PhotoRulesView(APIView):
    """What the Record Visit form needs to know before it asks for photos."""

    def get(self, request):
        return Response(photos.rules())


class PhotoUploadView(APIView):
    permission_classes = [IsSalesman]
    parser_classes = [MultiPartParser, FormParser]
    throttle_classes = [ScopedRateThrottle]
    throttle_scope = "visit_photo"

    def post(self, request):
        salesman = get_salesman(request.user)
        f = request.FILES.get("image")
        if f is None:
            from rest_framework.exceptions import ValidationError

            raise ValidationError({"image": "Attach a photo in the 'image' field."})
        photo = photos.save_upload(salesman, f, request.data.get("kind") or VisitPhoto.Kind.CAR)
        return Response(_row(photo), status=status.HTTP_201_CREATED)


class PhotoDetailView(APIView):
    """Remove a photo that has not been attached to a saved visit yet."""

    permission_classes = [IsSalesman]

    def delete(self, request, pk):
        salesman = get_salesman(request.user)
        photo = VisitPhoto.objects.filter(pk=pk, salesman=salesman, visit__isnull=True).first()
        if photo is None:
            raise NotFound("Photo not found")
        photos.remove_file(photo)
        photo.delete()
        return Response(status=status.HTTP_204_NO_CONTENT)


class PhotoImageView(APIView):
    """The image bytes. The uploading salesman and management only; there is no public media URL."""

    permission_classes = [IsAuthenticated]

    def get(self, request, pk):
        photo = VisitPhoto.objects.select_related("salesman").filter(pk=pk).first()
        if photo is None or not (request.user.is_management or photo.salesman.user_id == request.user.id):
            raise NotFound("Photo not found")  # the same answer for "missing" and "not yours"
        try:
            handle = photo.image.open("rb")
        except FileNotFoundError:
            raise NotFound("Photo not found")
        resp = FileResponse(handle, content_type="image/jpeg")
        resp["Cache-Control"] = "private, max-age=3600"
        resp["X-Content-Type-Options"] = "nosniff"
        resp["Content-Disposition"] = f'inline; filename="visit-photo-{photo.id}.jpg"'
        return resp
