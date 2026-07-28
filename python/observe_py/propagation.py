"""W3C traceparent format/parse — twin of ``src/core/propagation.ts``."""

from __future__ import annotations

import re

from pydantic import BaseModel, ConfigDict

_TRACE_ID = re.compile(r"^[0-9a-f]{32}$")
_SPAN_ID = re.compile(r"^[0-9a-f]{16}$")
_FLAGS = re.compile(r"^[0-9a-f]{2}$")

_ZERO_TRACE_ID = "0" * 32
_ZERO_SPAN_ID = "0" * 16


class TraceContext(BaseModel):
    model_config = ConfigDict(frozen=True)

    sampled: bool
    span_id: str
    trace_id: str


def format_traceparent(ctx: TraceContext) -> str:
    flags = "01" if ctx.sampled else "00"
    return f"00-{ctx.trace_id}-{ctx.span_id}-{flags}"


def parse_traceparent(header: str | None) -> TraceContext | None:
    if header is None or header == "":
        return None

    parts = header.split("-")
    if len(parts) != 4:
        return None

    version, trace_id, span_id, trace_flags = parts

    if version != "00":
        return None

    if not _is_valid_trace_id(trace_id):
        return None

    if not _is_valid_span_id(span_id):
        return None

    if not _FLAGS.match(trace_flags):
        return None

    sampled = (int(trace_flags, 16) & 0x01) == 1

    return TraceContext(sampled=sampled, span_id=span_id, trace_id=trace_id)


def _is_valid_span_id(span_id: str) -> bool:
    return bool(_SPAN_ID.match(span_id)) and span_id != _ZERO_SPAN_ID


def _is_valid_trace_id(trace_id: str) -> bool:
    return bool(_TRACE_ID.match(trace_id)) and trace_id != _ZERO_TRACE_ID
