import re


def normalize_phone(value: str) -> str:
    """Digits only, last 10 (drops +91 / 0 prefixes, spaces and dashes)."""
    digits = re.sub(r"\D", "", value or "")
    return digits[-10:]
