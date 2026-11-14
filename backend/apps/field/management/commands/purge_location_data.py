from django.core.management.base import BaseCommand

from apps.field.services import purge_location_data


class Command(BaseCommand):
    help = (
        "Retention: delete GPS points older than the configured retention window, scrub last-known positions on "
        "old sessions and trim the audit log. Run daily (cron / Task Scheduler)."
    )

    def add_arguments(self, parser):
        parser.add_argument("--dry-run", action="store_true", help="Report what would be removed, change nothing.")

    def handle(self, *args, dry_run=False, **opts):
        out = purge_location_data(dry_run=dry_run)
        prefix = "[dry run] would remove" if dry_run else "Removed"
        self.stdout.write(
            f"{prefix}: {out['pings']} GPS point(s), scrubbed {out['sessions_scrubbed']} old session position(s), "
            f"{out['audit_rows']} old audit row(s) (cutoff {out['cutoff']})."
        )
