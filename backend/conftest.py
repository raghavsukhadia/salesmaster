"""Test-suite defaults."""
import pytest
from django.core.cache import cache


@pytest.fixture(autouse=True)
def _clear_throttle_cache():
    """DRF throttle counters (the sign-in limits, the field pings) live in the process-wide cache, and usernames repeat
    between tests: without this a later test that signs in as "alice" inherits the earlier tests' attempts and gets a 429."""
    cache.clear()
    yield
    cache.clear()


@pytest.fixture(autouse=True)
def _visit_photos_not_required_by_default(settings, tmp_path):
    """Most tests post visits without photos and predate the "2 car photos" rule. Photo tests switch it back on
    explicitly (settings.VISIT_MIN_PHOTOS = 2). Uploaded files go to a throwaway folder, never backend/media."""
    settings.VISIT_MIN_PHOTOS = 0
    settings.MEDIA_ROOT = tmp_path / "media"
