"""Blank out the word "null" (and similar placeholders) that early dealer imports stored as real text,
so locations read "Nanded" instead of "Nanded, null". The import now drops these itself."""

from django.db import migrations

FIELDS = ("shop_name", "phone", "whatsapp", "address", "city", "state", "pincode", "gst_number")
BLANKS = ("null", "none", "nan", "n/a", "#n/a")


def clear(apps, schema_editor):
    Dealer = apps.get_model("dealers", "Dealer")
    for field in FIELDS:
        for word in BLANKS:
            Dealer.objects.filter(**{f"{field}__iexact": word}).update(**{field: ""})


class Migration(migrations.Migration):
    dependencies = [("dealers", "0007_field_location_master")]
    operations = [migrations.RunPython(clear, migrations.RunPython.noop)]
