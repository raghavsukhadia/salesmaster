from django.db import migrations, models


def backfill_salesman_names(apps, schema_editor):
    Visit = apps.get_model("visits", "Visit")
    alias = schema_editor.connection.alias
    batch = []
    for visit in Visit.objects.using(alias).select_related("salesman__user").iterator(chunk_size=1000):
        user = visit.salesman.user
        visit.salesman_name = f"{user.first_name} {user.last_name}".strip() or user.username
        batch.append(visit)
        if len(batch) == 1000:
            Visit.objects.using(alias).bulk_update(batch, ["salesman_name"], batch_size=1000)
            batch.clear()
    if batch:
        Visit.objects.using(alias).bulk_update(batch, ["salesman_name"], batch_size=1000)


class Migration(migrations.Migration):
    dependencies = [("visits", "0006_visitphoto")]

    operations = [
        migrations.AddField(
            model_name="visit",
            name="salesman_name",
            field=models.CharField(default="", editable=False, max_length=310),
        ),
        migrations.RunPython(backfill_salesman_names, migrations.RunPython.noop),
    ]
