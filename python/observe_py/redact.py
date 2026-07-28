"""Key denylist + value scanners — twin of ``src/core/redact.ts``.

Regexes are ported verbatim; ``re.ASCII`` pins ``\\w``/``\\d``/``\\b`` to the JS
semantics so the redaction fixtures agree byte-for-byte.
"""

from __future__ import annotations

import re
from collections.abc import Callable
from typing import Any

DENIED_KEYS = frozenset(
    {
        "api_key",
        "authorization",
        "card_number",
        "credit_card",
        "cvv",
        "password",
        "secret",
        "ssn",
    }
)


def _is_luhn_valid(candidate: str) -> bool:
    digits = re.sub(r"\D", "", candidate)
    if len(digits) < 13 or len(digits) > 19:
        return False

    total = 0
    double = False
    for char in reversed(digits):
        digit = ord(char) - 48
        if double:
            digit *= 2
            if digit > 9:
                digit -= 9
        total += digit
        double = not double

    return total % 10 == 0


_SCANNERS: tuple[tuple[re.Pattern[str], str, Callable[[str], bool] | None], ...] = (
    (re.compile(r"\beyJ[\w-]+\.[\w-]+\.[\w-]+", re.ASCII), "jwt", None),
    (re.compile(r"\b(?:sk|pk)_\w{8,}", re.ASCII), "api_key", None),
    (re.compile(r"\bAKIA[0-9A-Z]{16}\b", re.ASCII), "api_key", None),
    (re.compile(r"\b[\w.%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b", re.ASCII), "email", None),
    (re.compile(r"\b\d(?:[ -]?\d){12,18}\b", re.ASCII), "credit_card", _is_luhn_valid),
    (re.compile(r"\b(?:\d{1,3}\.){3}\d{1,3}\b", re.ASCII), "ipv4", None),
    (re.compile(r"\+\d(?:[ ().-]?\d){7,14}\b", re.ASCII), "phone", None),
)


def redact_event(event: dict[str, Any]) -> dict[str, Any]:
    """Return a scrubbed copy; the input event is never mutated."""
    output = dict(event)

    for key in list(output.keys()):
        if _is_denied_key(key):
            del output[key]
            continue

        output[key] = _redact_value(output[key])

    return output


def _is_denied_key(key: str) -> bool:
    return key in DENIED_KEYS or key.endswith("_token")


def _redact_object(source: dict[str, Any]) -> dict[str, Any]:
    output: dict[str, Any] = {}
    for key, value in source.items():
        if _is_denied_key(key):
            continue

        output[key] = _redact_value(value)

    return output


def _redact_value(value: Any) -> Any:
    if isinstance(value, str):
        return _scrub_string(value)

    if isinstance(value, dict):
        return _redact_object(value)

    return value


def _scrub_string(value: str) -> str:
    result = value
    for pattern, kind, validate in _SCANNERS:

        def replace(
            match: re.Match[str],
            kind: str = kind,
            validate: Callable[[str], bool] | None = validate,
        ) -> str:
            if validate is None or validate(match.group(0)):
                return f"[REDACTED:{kind}]"
            return match.group(0)

        result = pattern.sub(replace, result)

    return result
