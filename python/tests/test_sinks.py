"""Sink behavior — port of ``src/sinks/test/sentry.test.ts`` plus stdout/dev sinks."""

from __future__ import annotations

import asyncio
import json

import pytest

from observe_py.client import ObservabilityClient
from observe_py.sinks import ConsolePrettySink, MemorySink, SentrySink, StdoutJsonSink
from observe_py.types import ClientConfig


def make_event(**overrides) -> dict:
    return {
        "duration_ms": 42,
        "environment": "production",
        "event": "chat_turn",
        "event_id": "evt_0011223344556677",
        "outcome": "success",
        "route": "chat.stream",
        "runtime": "python",
        "schema_version": 1,
        "span_id": "00f067aa0ba902b7",
        "trace_id": "4bf92f3577b34da6a3ce929d0e0e4736",
        "ts": "2026-07-24T00:00:00.000Z",
        **overrides,
    }


class SentryCalls:
    def __init__(self, fail: bool = False) -> None:
        self.breadcrumbs: list[dict] = []
        self.tags: list[tuple[str, str]] = []
        self.contexts: list[tuple[str, dict | None]] = []
        self.flushes = 0
        self.fail = fail

    def add_breadcrumb(self, **breadcrumb) -> None:
        if self.fail:
            raise RuntimeError("sentry down")
        self.breadcrumbs.append(breadcrumb)

    def set_tag(self, key: str, value: str) -> None:
        if self.fail:
            raise RuntimeError("sentry down")
        self.tags.append((key, value))

    def set_context(self, name: str, context: dict | None) -> None:
        if self.fail:
            raise RuntimeError("sentry down")
        self.contexts.append((name, context))

    def flush(self) -> None:
        self.flushes += 1


def make_sentry() -> tuple[SentrySink, SentryCalls]:
    calls = SentryCalls()
    sink = SentrySink(
        add_breadcrumb=calls.add_breadcrumb,
        set_tag=calls.set_tag,
        set_context=calls.set_context,
        flush=calls.flush,
    )
    return sink, calls


def test_success_event_enriches_without_error_tags():
    sink, calls = make_sentry()
    sink.send(make_event())

    assert len(calls.breadcrumbs) == 1
    crumb = calls.breadcrumbs[0]
    assert crumb["category"] == "observe"
    assert crumb["level"] == "info"
    assert crumb["message"] == "chat_turn success 42ms"
    assert crumb["data"]["trace_id"] == "4bf92f3577b34da6a3ce929d0e0e4736"
    assert calls.tags == [("trace_id", "4bf92f3577b34da6a3ce929d0e0e4736")]
    assert calls.contexts == []


def test_error_event_adds_tags_and_context():
    sink, calls = make_sentry()
    sink.send(
        make_event(
            outcome="error",
            error={"code": "RATE_LIMITED", "message": "slow down", "type": "AppError"},
        )
    )

    assert calls.breadcrumbs[0]["level"] == "error"
    assert ("observe_event", "chat_turn") in calls.tags
    assert ("route", "chat.stream") in calls.tags
    name, context = calls.contexts[0]
    assert name == "observe"
    assert context["error_code"] == "RATE_LIMITED"
    assert context["span_id"] == "00f067aa0ba902b7"


def test_cancelled_maps_to_warning():
    sink, calls = make_sentry()
    sink.send(make_event(outcome="cancelled"))
    assert calls.breadcrumbs[0]["level"] == "warning"


def test_broken_vendor_functions_never_raise():
    calls = SentryCalls(fail=True)
    sink = SentrySink(
        add_breadcrumb=calls.add_breadcrumb,
        set_tag=calls.set_tag,
        set_context=calls.set_context,
        flush=calls.flush,
    )
    sink.send(make_event(outcome="error", error={"type": "AppError"}))  # must not raise


def test_flush_passthrough_and_guard():
    sink, calls = make_sentry()
    sink.flush()
    assert calls.flushes == 1

    def broken_flush() -> None:
        raise RuntimeError("flush down")

    broken = SentrySink(
        add_breadcrumb=calls.add_breadcrumb,
        set_tag=calls.set_tag,
        set_context=calls.set_context,
        flush=broken_flush,
    )
    broken.flush()  # must not raise


async def test_async_sentry_flush_is_awaited_by_client():
    flushed = False

    async def async_flush() -> None:
        nonlocal flushed
        await asyncio.sleep(0)
        flushed = True

    calls = SentryCalls()
    sink = SentrySink(
        add_breadcrumb=calls.add_breadcrumb,
        set_tag=calls.set_tag,
        set_context=calls.set_context,
        flush=async_flush,
    )
    client = ObservabilityClient(ClientConfig(sinks=(sink,)))
    await client.flush()
    assert flushed is True


def test_stdout_sink_emits_one_marked_json_line(capsys):
    StdoutJsonSink().send(make_event())
    lines = capsys.readouterr().out.strip().splitlines()
    assert len(lines) == 1
    parsed = json.loads(lines[0])
    assert parsed["type"] == "observability_event"
    assert parsed["event"]["event"] == "chat_turn"


def test_stdout_sink_surfaces_non_json_values():
    with pytest.raises(TypeError):
        StdoutJsonSink().send(make_event(bad=object()))


def test_memory_sink_records_and_clears():
    sink = MemorySink()
    sink.send(make_event())
    assert len(sink.events) == 1
    sink.clear()
    assert sink.events == []


def test_pretty_sink_does_not_crash(capsys):
    ConsolePrettySink().send(make_event())
    assert "chat_turn" in capsys.readouterr().out
