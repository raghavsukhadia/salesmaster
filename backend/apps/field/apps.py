from django.apps import AppConfig


class FieldAppConfig(AppConfig):
    name = "apps.field"
    label = "field"
    default_auto_field = "django.db.models.BigAutoField"
