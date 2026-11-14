from django.core.management.base import BaseCommand

from apps.field.services import close_stale_sessions


class Command(BaseCommand):
    help = "End duty sessions that were left running past FIELD_TRACKING['MAX_SESSION_H']. Safe to run often."

    def handle(self, *args, **opts):
        self.stdout.write(f"Closed {close_stale_sessions()} stale duty session(s).")
