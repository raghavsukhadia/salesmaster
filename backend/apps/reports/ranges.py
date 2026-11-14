"""Date presets for the report filters. Pure functions of (preset, from, to, today) so they are easy to test."""
import calendar
import re
from dataclasses import dataclass
from datetime import date, datetime, time, timedelta

from django.utils import timezone
from rest_framework.exceptions import ValidationError

DEFAULT_PRESET = "last30"
PRESET_LABELS = {
    "today": "Today",
    "yesterday": "Yesterday",
    "last7": "Last 7 days",
    "last30": "Last 30 days",
    "this_month": "This month",
    "last_month": "Last month",
    "this_year": "This year",
    "custom": "Custom range",
    "all": "All time",
}
MONTH_RE = re.compile(r"^(\d{4})-(0[1-9]|1[0-2])$")


@dataclass(frozen=True)
class DateRange:
    preset: str
    start: date | None  # inclusive; None = from the beginning
    end: date | None  # inclusive; None = open ended
    label: str

    def bounds(self):
        """Aware [lo, hi) datetimes in the project time zone, for index-friendly `visited_at` range filters."""
        tz = timezone.get_current_timezone()
        lo = datetime.combine(self.start, time.min, tzinfo=tz) if self.start else None
        hi = datetime.combine(self.end + timedelta(days=1), time.min, tzinfo=tz) if self.end else None
        return lo, hi


def parse_day(value: str, name: str) -> date:
    try:
        return date.fromisoformat(value)
    except (TypeError, ValueError):
        raise ValidationError({name: "Use the format YYYY-MM-DD"})


def month_bounds(year: int, month: int) -> tuple[date, date]:
    return date(year, month, 1), date(year, month, calendar.monthrange(year, month)[1])


def month_range(value: str, name: str = "month") -> DateRange:
    """A whole calendar month from 'YYYY-MM'."""
    m = MONTH_RE.match(value or "")
    if not m:
        raise ValidationError({name: "Use the format YYYY-MM"})
    start, end = month_bounds(int(m.group(1)), int(m.group(2)))
    return DateRange("custom", start, end, start.strftime("%b %Y"))


def custom_range(start: date, end: date) -> DateRange:
    if start > end:
        raise ValidationError({"from": "The start date must not be after the end date"})
    return DateRange("custom", start, end, f"{start:%d %b %Y} – {end:%d %b %Y}")


def resolve_range(preset=None, date_from=None, date_to=None, today=None) -> DateRange:
    today = today or timezone.localdate()
    preset = preset or DEFAULT_PRESET
    if preset not in PRESET_LABELS:
        raise ValidationError({"preset": "Unknown date range"})
    label = PRESET_LABELS[preset]
    if preset == "today":
        return DateRange(preset, today, today, label)
    if preset == "yesterday":
        d = today - timedelta(days=1)
        return DateRange(preset, d, d, label)
    if preset == "last7":
        return DateRange(preset, today - timedelta(days=6), today, label)
    if preset == "last30":
        return DateRange(preset, today - timedelta(days=29), today, label)
    if preset == "this_month":
        return DateRange(preset, today.replace(day=1), today, label)
    if preset == "last_month":
        first_of_this = today.replace(day=1)
        last = first_of_this - timedelta(days=1)
        return DateRange(preset, last.replace(day=1), last, label)
    if preset == "this_year":
        return DateRange(preset, today.replace(month=1, day=1), today, label)
    if preset == "all":
        return DateRange(preset, None, None, label)
    # custom
    if not date_from:
        raise ValidationError({"from": "Choose a start date for a custom range"})
    start = parse_day(date_from, "from")
    end = parse_day(date_to, "to") if date_to else today
    return custom_range(start, end)
