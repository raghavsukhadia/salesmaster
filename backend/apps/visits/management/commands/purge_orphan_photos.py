from django.core.management.base import BaseCommand

from apps.visits.photos import purge_orphans


class Command(BaseCommand):
    help = "Delete staged visit photos that were never attached to a saved visit (abandoned forms) after 24 h. Run daily."

    def add_arguments(self, parser):
        parser.add_argument("--dry-run", action="store_true")

    def handle(self, *args, dry_run=False, **opts):
        n = purge_orphans(dry_run=dry_run)
        self.stdout.write(f"{'[dry run] would remove' if dry_run else 'Removed'} {n} orphaned visit photo(s).")
