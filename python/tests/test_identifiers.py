"""Port of ``src/core/test/identifier.test.ts``."""

from __future__ import annotations

import re

from observe_py.identifiers import (
    new_event_id,
    new_request_id,
    new_span_id,
    new_trace_id,
)

from .conftest import deterministic_random_bytes


def test_id_shapes():
    assert re.fullmatch(r"[0-9a-f]{32}", new_trace_id())
    assert re.fullmatch(r"[0-9a-f]{16}", new_span_id())
    assert re.fullmatch(r"evt_[0-9a-f]{16}", new_event_id())
    assert re.fullmatch(r"req_[0-9a-f]{16}", new_request_id())


def test_deterministic_rng_injection():
    assert new_span_id(deterministic_random_bytes) == bytes(range(1, 9)).hex()


def test_all_zero_bytes_are_rejected():
    zero_rng = bytes
    assert new_span_id(zero_rng) == "0" * 14 + "01"
    assert new_trace_id(zero_rng) == "0" * 30 + "01"


def test_ids_are_unique():
    assert new_trace_id() != new_trace_id()
    assert new_span_id() != new_span_id()
