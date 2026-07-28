"""Trace/span/event/request id generation — twin of ``src/core/identifier.ts``."""

from __future__ import annotations

import secrets

from .types import RandomBytes

TRACE_ID_BYTES = 16
SPAN_ID_BYTES = 8
READABLE_ID_BYTES = 8


def default_random_bytes(count: int) -> bytes:
    return secrets.token_bytes(count)


def new_event_id(rng: RandomBytes = default_random_bytes) -> str:
    return f"evt_{_random_hex(READABLE_ID_BYTES, rng)}"


def new_request_id(rng: RandomBytes = default_random_bytes) -> str:
    return f"req_{_random_hex(READABLE_ID_BYTES, rng)}"


def new_span_id(rng: RandomBytes = default_random_bytes) -> str:
    return _random_hex(SPAN_ID_BYTES, rng)


def new_trace_id(rng: RandomBytes = default_random_bytes) -> str:
    return _random_hex(TRACE_ID_BYTES, rng)


def _random_hex(byte_count: int, rng: RandomBytes) -> str:
    raw = bytearray(rng(byte_count))
    if not any(raw):
        raw[-1] = 1  # all-zero ids are invalid per W3C trace context
    return raw.hex()
