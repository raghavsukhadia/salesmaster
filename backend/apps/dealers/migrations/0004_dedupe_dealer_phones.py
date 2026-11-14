"""Make dealer phones safe for a unique constraint (added in 0005).

1. Normalise every phone/whatsapp to its last 10 digits.
2. When several dealers share a phone, the oldest dealer keeps it. For the others the number is
   not lost: it is copied to a contact on that dealer ("Duplicate phone (migrated)") and the
   dealer's own phone is cleared. No dealer, visit or ownership row is deleted or merged.
"""

import re

from django.db import migrations


def _norm(value):
    return re.sub(r"\D", "", value or "")[-10:]


def dedupe(apps, schema_editor):
    Dealer = apps.get_model("dealers", "Dealer")
    DealerContact = apps.get_model("dealers", "DealerContact")

    seen = set()
    for dealer in Dealer.objects.order_by("id").iterator():
        phone, whatsapp = _norm(dealer.phone), _norm(dealer.whatsapp)
        moved = ""
        if phone and phone in seen:
            moved, phone = phone, ""
        elif phone:
            seen.add(phone)
        if moved:
            DealerContact.objects.create(
                dealer=dealer, name="Duplicate phone (migrated)", phone=moved, whatsapp=""
            )
        if (phone, whatsapp) != (dealer.phone, dealer.whatsapp):
            Dealer.objects.filter(pk=dealer.pk).update(phone=phone, whatsapp=whatsapp)


class Migration(migrations.Migration):

    dependencies = [("dealers", "0003_dealer_detail")]

    operations = [migrations.RunPython(dedupe, migrations.RunPython.noop)]
