"""observe-py — wide-event observability SDK, the Python twin of ``../src``.

Public surface mirrors ``src/index.ts``: the ambient ``obs`` API, install,
id helpers, and traceparent helpers. Client, middleware, and sinks are imported
from their modules, mirroring the TS subpath exports.
"""

from .accumulator import Span
from .context import current_span, install_observability, obs, observed
from .identifiers import (
    default_random_bytes,
    new_event_id,
    new_request_id,
    new_span_id,
    new_trace_id,
)
from .propagation import TraceContext, format_traceparent, parse_traceparent

__all__ = [
    "Span",
    "TraceContext",
    "current_span",
    "default_random_bytes",
    "format_traceparent",
    "install_observability",
    "new_event_id",
    "new_request_id",
    "new_span_id",
    "new_trace_id",
    "obs",
    "observed",
    "parse_traceparent",
]
