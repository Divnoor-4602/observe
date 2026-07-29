"""Bag helpers and the envelope trust boundary — twins of ``src/core/wide-event.ts``
and the snake_case refinement in ``src/core/schema.ts``."""

from __future__ import annotations

import json
import re
from typing import Any

from .envelope import WideEvent

KEY_PATTERN = re.compile(r"^[a-z][a-z0-9_]*$")


def deep_merge(target: dict[str, Any], source: dict[str, Any]) -> None:
    for key, source_value in source.items():
        # TS drops prototype-pollution keys; retain that guard for emission parity.
        if key in {"__proto__", "constructor"}:
            continue
        if isinstance(source_value, dict):
            existing = target.get(key)
            nested = existing if isinstance(existing, dict) else {}
            deep_merge(nested, source_value)
            target[key] = nested
        else:
            target[key] = source_value


def has_valid_keys(value: dict[str, Any]) -> bool:
    for key, nested in value.items():
        if not isinstance(key, str) or not KEY_PATTERN.fullmatch(key):
            return False
        if isinstance(nested, dict) and not has_valid_keys(nested):
            return False
    return True


def read_string(value: Any) -> str | None:
    return value if isinstance(value, str) else None


def validate_wide_event(data: dict[str, Any]) -> WideEvent:
    """Trust-boundary validation: recursive snake_case keys plus envelope shape.

    Use at ingest boundaries (e.g. the browser relay endpoint), mirroring the
    ``wideEventSchema`` export in TS.
    """
    if not has_valid_keys(data):
        raise ValueError("wide event keys must be lowercase snake_case")
    # Strict JSON mode keeps wire-format enum strings valid while rejecting
    # coercions such as a string supplied for a numeric field.
    return WideEvent.model_validate_json(json.dumps(data), strict=True)
