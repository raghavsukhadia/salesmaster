from django.contrib import admin

from .models import FieldAuditLog, FieldConfig

# Raw GPS tables (WorkSession, LocationPing) are deliberately NOT registered here: browsing them in Django
# admin would bypass the audit log. All reads of location data go through the audited management API.
admin.site.register(FieldConfig)
admin.site.register(FieldAuditLog)
