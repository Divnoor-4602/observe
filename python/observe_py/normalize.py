"""Scalar-leaf coercion and caps — twin of ``src/core/normalize.ts``.

Python deltas per ``docs/python-port.md``: big ints stay numbers (the TS
``bigint → string`` rule is JS-specific), explicit ``None`` is kept (Python has
no ``undefined``), ``Decimal`` never survives (coerced to float).
"""

from __future__ import annotations

import math
from datetime import datetime
from decimal import Decimal
from typing import Any

MAX_STRING = 1024
MAX_FIELDS = 256
MAX_DEPTH = 6

FORBIDDEN_PREFIXES = ("gen_ai.input", "gen_ai.output", "gen_ai.system_instructions")

_DROP = object()


def normalize(bag: dict[str, Any]) -> None:
    _normalize_object(bag, "", 0, [0])


def _is_forbidden_path(path: str) -> bool:
    return any(path == prefix or path.startswith(f"{prefix}.") for prefix in FORBIDDEN_PREFIXES)


def _normalize_leaf(value: Any) -> Any:
    if isinstance(value, str):
        return f"{value[:MAX_STRING]}…" if len(value) > MAX_STRING else value

    if isinstance(value, bool):  # bool is an int subclass — must precede the number check
        return value

    if isinstance(value, int):
        return value

    if isinstance(value, float):
        return value if math.isfinite(value) else None

    if value is None:
        return None

    if isinstance(value, datetime):
        return value.isoformat()

    if isinstance(value, Decimal):
        as_float = float(value)
        return as_float if math.isfinite(as_float) else None

    return _DROP


def _normalize_object(
    bag: dict[str, Any],
    path: str,
    depth: int,
    counter: list[int],
) -> None:
    for key in list(bag.keys()):
        field_path = key if path == "" else f"{path}.{key}"
        value = bag[key]

        if _is_forbidden_path(field_path) or counter[0] >= MAX_FIELDS:
            del bag[key]
            continue

        if isinstance(value, dict):
            if depth >= MAX_DEPTH:
                del bag[key]
            else:
                _normalize_object(value, field_path, depth + 1, counter)
            continue

        leaf = _normalize_leaf(value)
        if leaf is _DROP:
            del bag[key]
            continue

        bag[key] = leaf
        counter[0] += 1
