"""Outbound propagation for httpx — per ``docs/python-port.md``.

Register on the shared client once and every downstream call carries the
current span's identity::

    httpx.AsyncClient(event_hooks={"request": [inject_traceparent]})
"""

from __future__ import annotations

from typing import TYPE_CHECKING

from .context import current_span
from .propagation import TraceContext, format_traceparent

if TYPE_CHECKING:
    import httpx


async def inject_traceparent(request: httpx.Request) -> None:
    span = current_span.get()
    if span is None:
        return

    trace_id = span.trace_id
    span_id = span.span_id
    if trace_id is None or span_id is None:
        return

    # The flag is advisory: receivers re-derive keep/drop from trace_id
    # (deterministic head sampling), so a hop never flips a trace's decision.
    request.headers["traceparent"] = format_traceparent(
        TraceContext(sampled=True, span_id=span_id, trace_id=trace_id)
    )
