from datetime import datetime, timedelta

from django.utils import timezone
from rest_framework.exceptions import ValidationError

# A form left open for a few minutes must not reject a time that was still "now" when it was typed.
PAST_GRACE = timedelta(minutes=5)


def check_time_not_past(due_date, due_time) -> None:
    """A follow-up time today must not already have passed. A time on any later day is always fine, and no time is fine."""
    if due_time is None or due_date != timezone.localdate():
        return
    moment = timezone.make_aware(datetime.combine(due_date, due_time))
    if moment < timezone.now() - PAST_GRACE:
        raise ValidationError({"due_time": "That time has already passed today"})
