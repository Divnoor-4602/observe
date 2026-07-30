"""Port of the behaviors in ``src/core/test/client.test.ts`` plus the
asyncio-interleaving guarantees the ContextVar design must provide."""

from __future__ import annotations

import asyncio

import pytest

from observe_py.client import ObservabilityClient
from observe_py.context import current_span
from observe_py.sinks import MemorySink
from observe_py.types import ClientConfig
from observe_py.wide_event import validate_wide_event

from .conftest import deterministic_random_bytes


def make_client(memory_sink: MemorySink, **overrides) -> ObservabilityClient:
    config = {
        "environment": "production",
        "sample_rate": 1,
        "sinks": (memory_sink,),
        **overrides,
    }
    return ObservabilityClient(ClientConfig(**config))


def test_span_emits_exactly_one_valid_envelope(memory_sink):
    client = make_client(memory_sink, service="server-layer", service_version="1.2.3")
    span = client.begin("chat_turn", route="chat.stream")
    span.add({"user_tier": "free"})
    span.end()
    span.end()  # idempotent

    assert len(memory_sink.events) == 1
    event = memory_sink.events[0]
    validate_wide_event(event)
    assert event["event"] == "chat_turn"
    assert event["route"] == "chat.stream"
    assert event["runtime"] == "python"
    assert event["service"] == "server-layer"
    assert event["outcome"] == "success"
    assert event["schema_version"] == 1
    assert event["ts"].endswith("Z")


def test_ended_span_ignores_add_and_error(memory_sink):
    client = make_client(memory_sink)
    span = client.begin("chat_turn")
    span.end()
    span.add({"late": "value"})
    span.error(RuntimeError("late"))

    assert len(memory_sink.events) == 1
    assert "late" not in memory_sink.events[0]
    assert memory_sink.events[0]["outcome"] == "success"


def test_error_spans_bypass_sampling(memory_sink):
    client = make_client(memory_sink, sample_rate=0)
    span = client.begin("model_call")
    span.error(RuntimeError("boom"))
    span.end()

    assert len(memory_sink.events) == 1
    event = memory_sink.events[0]
    assert event["outcome"] == "error"
    assert event["error"]["type"] == "RuntimeError"
    assert event["error"]["message"] == "boom"
    assert event["sample_rate"] == 1
    assert event["sampled"] is True


def test_error_code_is_lifted_from_exception():
    class AppError(RuntimeError):
        def __init__(self, message: str, code: str) -> None:
            super().__init__(message)
            self.code = code

    sink = MemorySink()
    client = make_client(sink)
    span = client.begin("model_call")
    span.error(AppError("rate limited", "RATE_LIMITED"))
    span.end()

    assert sink.events[0]["error"]["code"] == "RATE_LIMITED"


def test_error_code_is_lifted_from_structured_data():
    class AppError(RuntimeError):
        def __init__(self, message: str, code: str) -> None:
            super().__init__(message)
            self.data = {"code": code}

    sink = MemorySink()
    client = make_client(sink)
    span = client.begin("model_call")
    span.error(AppError("forbidden", "FORBIDDEN"))
    span.end()

    assert sink.events[0]["error"]["code"] == "FORBIDDEN"


def test_success_dropped_at_rate_zero(memory_sink):
    client = make_client(memory_sink, sample_rate=0)
    client.begin("chat_turn").end()
    assert memory_sink.events == []


def test_exempt_tier_bypasses_sampling(memory_sink):
    client = make_client(memory_sink, sample_rate=0, sample_exempt_tiers=("premium",))
    span = client.begin("chat_turn")
    span.add({"user_tier": "premium"})
    span.end()

    assert len(memory_sink.events) == 1
    assert memory_sink.events[0]["sample_rate"] == 1


def test_emitted_event_is_redacted_span_data_is_not(memory_sink):
    client = make_client(memory_sink)
    span = client.begin("chat_turn")
    span.add({"api_key": "sk_live_secret", "note": "mail jane.doe@example.com"})
    span.end()

    event = memory_sink.events[0]
    assert "api_key" not in event
    assert event["note"] == "mail [REDACTED:email]"


def test_get_context_fields_land_and_meta_wins(memory_sink):
    client = make_client(
        memory_sink,
        get_context=lambda: {"region_hint": "us-east1", "route": "from-context"},
    )
    client.begin("chat_turn", route="from-meta").end()

    event = memory_sink.events[0]
    assert event["region_hint"] == "us-east1"
    assert event["route"] == "from-meta"


def test_get_context_and_meta_deep_merge(memory_sink):
    client = make_client(
        memory_sink,
        get_context=lambda: {
            "gen_ai": {
                "provider": {"name": "openai"},
                "request": {"temperature": 0.2},
            }
        },
    )
    client.begin(
        "model_call",
        gen_ai={"request": {"model": "gpt-5.5"}},
    ).end()

    assert memory_sink.events[0]["gen_ai"] == {
        "provider": {"name": "openai"},
        "request": {"model": "gpt-5.5", "temperature": 0.2},
    }


def test_get_context_failure_is_swallowed(memory_sink):
    def broken() -> dict:
        raise RuntimeError("no request state")

    client = make_client(memory_sink, get_context=broken)
    client.begin("chat_turn").end()
    assert len(memory_sink.events) == 1


def test_config_stamps_override_meta(memory_sink):
    client = make_client(memory_sink, deployment="blue")
    client.begin("chat_turn", deployment="spoofed", region="spoofed").end()

    event = memory_sink.events[0]
    assert event["deployment"] == "blue"
    assert "region" not in event  # unset config erases a meta-provided value


def test_sink_exception_is_isolated(memory_sink):
    class BrokenSink:
        name = "broken"

        def send(self, event) -> None:
            raise RuntimeError("sink down")

    client = make_client(memory_sink)
    client._config = client._config.model_copy(update={"sinks": (BrokenSink(), memory_sink)})
    client.begin("chat_turn").end()
    assert len(memory_sink.events) == 1


def test_each_sink_receives_an_independent_redacted_clone(memory_sink):
    class MutatingSink:
        name = "mutating"

        def send(self, event) -> None:
            event["note"] = "changed by first sink"

    client = make_client(memory_sink)
    client._config = client._config.model_copy(
        update={"sinks": (MutatingSink(), memory_sink)}
    )
    client.begin("chat_turn", note="original").end()

    assert memory_sink.events[0]["note"] == "original"


def test_explicit_trace_adoption(memory_sink):
    client = make_client(memory_sink, random_bytes=deterministic_random_bytes)
    trace_id = "4bf92f3577b34da6a3ce929d0e0e4736"
    span = client.begin("api_ingress", trace_id=trace_id, parent_span_id="00f067aa0ba902b7")
    span.end()

    event = memory_sink.events[0]
    assert event["trace_id"] == trace_id
    assert event["parent_span_id"] == "00f067aa0ba902b7"


def test_explicit_empty_trace_ids_win_over_ambient_parent(memory_sink):
    client = make_client(memory_sink)
    with client.span("parent"):
        client.begin("child", trace_id="", parent_span_id="").end()

    child_event, _ = memory_sink.events
    assert child_event["trace_id"] == ""
    assert child_event["parent_span_id"] == ""


def test_merge_drops_prototype_pollution_keys(memory_sink):
    client = make_client(memory_sink)
    span = client.begin("chat_turn")
    span.add({"__proto__": "x", "constructor": "y"})
    span.end()

    assert "__proto__" not in memory_sink.events[0]
    assert "constructor" not in memory_sink.events[0]


async def test_child_spans_share_trace_and_link_parent(memory_sink):
    client = make_client(memory_sink)
    with client.span("api_ingress") as parent:
        child = parent.child("model_call")
        child.end()

    child_event, parent_event = memory_sink.events
    assert child_event["event"] == "model_call"
    assert child_event["trace_id"] == parent_event["trace_id"]
    assert child_event["parent_span_id"] == parent_event["span_id"]


async def test_nested_spans_infer_parent_from_context(memory_sink):
    client = make_client(memory_sink)
    with client.span("api_ingress"):
        with client.span("model_call"):
            pass

    inner, outer = memory_sink.events
    assert inner["trace_id"] == outer["trace_id"]
    assert inner["parent_span_id"] == outer["span_id"]


async def test_span_records_error_and_reraises(memory_sink):
    client = make_client(memory_sink)
    with pytest.raises(ValueError, match="bad input"):
        with client.span("api_ingress"):
            raise ValueError("bad input")

    event = memory_sink.events[0]
    assert event["outcome"] == "error"
    assert event["error"]["type"] == "ValueError"
    assert current_span.get() is None


async def test_cancelled_span_emits_cancelled_without_error(memory_sink):
    client = make_client(memory_sink)

    async def cancelled_work() -> None:
        with client.span("cancelled_work"):
            await asyncio.Event().wait()

    task = asyncio.create_task(cancelled_work())
    await asyncio.sleep(0)
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task

    assert len(memory_sink.events) == 1
    assert memory_sink.events[0]["outcome"] == "cancelled"
    assert "error" not in memory_sink.events[0]


async def test_concurrent_spans_do_not_cross_contaminate(memory_sink):
    client = make_client(memory_sink)

    async def worker(name: str, delay: float) -> None:
        with client.span(name):
            await asyncio.sleep(delay)
            client.add({"who": name})

    await asyncio.gather(worker("span_a", 0.02), worker("span_b", 0.01))

    by_name = {event["event"]: event for event in memory_sink.events}
    assert by_name["span_a"]["who"] == "span_a"
    assert by_name["span_b"]["who"] == "span_b"
    assert by_name["span_a"]["trace_id"] != by_name["span_b"]["trace_id"]
    assert "parent_span_id" not in by_name["span_a"]
    assert "parent_span_id" not in by_name["span_b"]


async def test_flush_awaits_async_sinks(memory_sink):
    class SlowSink:
        name = "slow"

        def __init__(self) -> None:
            self.delivered: list[dict] = []

        async def send(self, event) -> None:
            await asyncio.sleep(0.02)
            self.delivered.append(event)

    slow = SlowSink()
    client = make_client(memory_sink)
    client._config = client._config.model_copy(update={"sinks": (slow,)})

    client.begin("chat_turn").end()
    assert slow.delivered == []
    await client.flush()
    assert len(slow.delivered) == 1


async def test_flush_calls_sink_flush(memory_sink):
    flushed = []

    class FlushableSink:
        name = "flushable"

        def send(self, event) -> None:
            return None

        def flush(self) -> None:
            flushed.append(True)

    client = make_client(memory_sink)
    client._config = client._config.model_copy(update={"sinks": (FlushableSink(),)})
    await client.flush()
    assert flushed == [True]


async def test_flush_settles_all_sinks_when_one_raises(memory_sink):
    flushed = asyncio.Event()

    class BrokenFlushSink:
        name = "broken"

        def send(self, event) -> None:
            return None

        async def flush(self) -> None:
            await asyncio.sleep(0)
            raise RuntimeError("flush down")

    class WorkingFlushSink:
        name = "working"

        def send(self, event) -> None:
            return None

        async def flush(self) -> None:
            await asyncio.sleep(0)
            flushed.set()

    client = make_client(memory_sink)
    client._config = client._config.model_copy(
        update={"sinks": (BrokenFlushSink(), WorkingFlushSink())}
    )
    await client.flush()
    assert flushed.is_set()
