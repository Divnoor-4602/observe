"""Deterministic head sampling — twin of ``src/core/sample.ts``.

The keep decision is a pure function of ``trace_id``, so the browser and every
Python service agree without coordination.
"""

from __future__ import annotations

import re
from collections.abc import Sequence
from typing import Any

from pydantic import BaseModel

DEFAULT_SAMPLE_RATE = 0.2
SAMPLE_HEX_CHARS = 8
SAMPLE_BUCKETS = 16**SAMPLE_HEX_CHARS
HEX_PREFIX = re.compile(r"^[0-9a-fA-F]+")


class SampleDecision(BaseModel):
    sample_rate: float
    should_keep: bool


def get_sample_decision(
    event: dict[str, Any],
    rate: float,
    exempt_tiers: Sequence[str],
) -> SampleDecision:
    if event.get("outcome") == "error":
        return SampleDecision(sample_rate=1, should_keep=True)

    user_tier = event.get("user_tier")
    if user_tier is not None and user_tier in exempt_tiers:
        return SampleDecision(sample_rate=1, should_keep=True)

    trace_id = event.get("trace_id")
    return SampleDecision(
        sample_rate=rate,
        should_keep=is_sampled(trace_id if isinstance(trace_id, str) else "", rate),
    )


def is_sampled(trace_id: str, rate: float) -> bool:
    if rate >= 1:
        return True

    if rate <= 0:
        return False

    prefix = HEX_PREFIX.match(trace_id[:SAMPLE_HEX_CHARS])
    if prefix is None:
        return True  # malformed id → keep, mirroring the TS NaN branch
    bucket = int(prefix.group(), 16)

    return bucket < rate * SAMPLE_BUCKETS


def resolve_sample_rate(rate: float | None) -> float:
    if rate is None:
        return DEFAULT_SAMPLE_RATE

    if rate >= 1:
        return 1

    if rate <= 0:
        return 0

    return rate
