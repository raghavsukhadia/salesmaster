"""An explicit, backed-up reset of the local demo database; never usable against PostgreSQL."""
import json
import sqlite3
from pathlib import Path

from django.apps import apps
from django.conf import settings
from django.core.management.base import BaseCommand, CommandError
from django.db import connection, transaction
from django.utils import timezone

from apps.accounts.models import Salesman, User


KEEP_USERS = ("admin", "demo@sunkool.in")
# Child rows go first because historical sales/field records deliberately use PROTECT foreign keys.
CLEAR_MODELS = (
    "field.DealerCheckIn", "field.BeatStop", "field.BeatPlan",
    "visits.VisitPhoto", "visits.VisitProduct", "visits.VisitOrderItem", "visits.Followup", "visits.Visit",
    "field.FieldAuditLog", "field.LocationPing", "field.WorkSession",
    "dealers.DealerAccessGrant", "dealers.DealerOwnershipHistory", "dealers.DealerContact", "dealers.Dealer",
    "dealers.Distributor", "dealers.DealerStatus", "visits.Product",
    "accounts.SalesmanTerritory", "field.FieldConfig", "admin.LogEntry", "sessions.Session",
)


class Command(BaseCommand):
    help = "Preview or clear local sample data, keeping admin and demo@sunkool.in and their salesman profiles."

    def add_arguments(self, parser):
        parser.add_argument("--apply", action="store_true", help="Apply the reset after making a SQLite backup.")
        parser.add_argument("--backup-dir", default=str(settings.BASE_DIR / ".backups"))

    def handle(self, *args, **options):
        if connection.vendor != "sqlite":
            raise CommandError("This command only supports local SQLite. It must never run on Cloud SQL.")
        db_path = Path(connection.settings_dict["NAME"]).resolve()
        if db_path.parent != settings.BASE_DIR.resolve() or not db_path.is_file():
            raise CommandError("Expected a local database file directly inside the backend directory.")
        users = list(User.objects.filter(username__in=KEEP_USERS).order_by("pk"))
        if {user.username for user in users} != set(KEEP_USERS):
            raise CommandError("Both admin and demo@sunkool.in must already exist. Nothing has been deleted.")
        admin = next(user for user in users if user.username == "admin")
        demo = next(user for user in users if user.username == "demo@sunkool.in")
        if admin.role != "admin" or demo.role != "salesman" or not Salesman.objects.filter(user=demo, is_active=True).exists():
            raise CommandError("Expected an admin account and an active demo salesman profile.")

        models = [apps.get_model(label) for label in CLEAR_MODELS]
        keep_ids = [user.pk for user in users]
        original_credentials = {user.pk: user.password for user in users}
        kept_profiles = set(Salesman.objects.filter(user_id__in=keep_ids).values_list("pk", flat=True))
        plan = {
            "keep_users": list(KEEP_USERS),
            "extra_users_to_remove": User.objects.exclude(pk__in=keep_ids).count(),
            "extra_salesman_profiles_to_remove": Salesman.objects.exclude(user_id__in=keep_ids).count(),
            "clear": {model._meta.label: model.objects.count() for model in models},
        }
        self.stdout.write(json.dumps(plan, indent=2))
        if not options["apply"]:
            self.stdout.write("Preview only. Add --apply to back up and clear this local sample data.")
            return

        backup_dir = Path(options["backup_dir"]).resolve()
        backup_dir.mkdir(parents=True, exist_ok=True)
        stamp = timezone.localtime().strftime("%Y%m%d_%H%M%S_%f")
        backup = backup_dir / f"before_demo_cleanup_{stamp}.sqlite3"
        with sqlite3.connect(str(db_path)) as source, sqlite3.connect(str(backup)) as target:
            source.backup(target)
            if target.execute("PRAGMA integrity_check").fetchone()[0] != "ok":
                raise CommandError("Backup verification failed. Nothing has been deleted.")
        self.stdout.write(f"Verified backup: {backup}")

        with transaction.atomic():
            for model in models:
                model.objects.all().delete()
            Salesman.objects.exclude(user_id__in=keep_ids).delete()
            User.objects.exclude(pk__in=keep_ids).delete()
            if dict(User.objects.values_list("pk", "password")) != original_credentials:
                raise CommandError("Account preservation failed; the database reset has been rolled back.")
            if set(Salesman.objects.values_list("pk", flat=True)) != kept_profiles:
                raise CommandError("Salesman profile preservation failed; the reset has been rolled back.")
        self.stdout.write(self.style.SUCCESS("Cleared sample data. Kept admin and demo@sunkool.in with unchanged passwords."))
