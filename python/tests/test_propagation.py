"""Port of ``src/core/test/propagation.test.ts``."""

from __future__ import annotations

import pytest

from observe_py.propagation import TraceContext, format_traceparent, parse_traceparent

TRACE_ID = "4bf92f3577b34da6a3ce929d0e0e4736"
SPAN_ID = "00f067aa0ba902b7"


def test_format_sampled():
    ctx = TraceContext(sampled=True, span_id=SPAN_ID, trace_id=TRACE_ID)
    assert format_traceparent(ctx) == f"00-{TRACE_ID}-{SPAN_ID}-01"


def test_format_not_sampled():
    ctx = TraceContext(sampled=False, span_id=SPAN_ID, trace_id=TRACE_ID)
    assert format_traceparent(ctx) == f"00-{TRACE_ID}-{SPAN_ID}-00"


def test_roundtrip():
    ctx = TraceContext(sampled=True, span_id=SPAN_ID, trace_id=TRACE_ID)
    assert parse_traceparent(format_traceparent(ctx)) == ctx


def test_parse_reads_sampled_flag():
    parsed = parse_traceparent(f"00-{TRACE_ID}-{SPAN_ID}-00")
    assert parsed is not None
    assert parsed.sampled is False
    # only the least-significant bit is the sampled flag
    parsed_ff = parse_traceparent(f"00-{TRACE_ID}-{SPAN_ID}-ff")
    assert parsed_ff is not None
    assert parsed_ff.sampled is True


@pytest.mark.parametrize(
    "header",
    [
        None,
        "",
        "garbage",
        f"01-{TRACE_ID}-{SPAN_ID}-01",  # wrong version
        f"00-{TRACE_ID[:31]}-{SPAN_ID}-01",  # short trace id
        f"00-{TRACE_ID}-{SPAN_ID[:15]}-01",  # short span id
        f"00-{'0' * 32}-{SPAN_ID}-01",  # all-zero trace id
        f"00-{TRACE_ID}-{'0' * 16}-01",  # all-zero span id
        f"00-{TRACE_ID.upper()}-{SPAN_ID}-01",  # uppercase hex is invalid
        f"00-{TRACE_ID}-{SPAN_ID}-0g",  # non-hex flags
        f"00-{TRACE_ID}-{SPAN_ID}",  # missing flags
    ],
)
def test_parse_rejects_invalid(header):
    assert parse_traceparent(header) is None
