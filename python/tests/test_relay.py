"""Relay ingest boundary — validate, never re-sample, never re-span, re-redact."""

# NOTE: no `from __future__ import annotations` here — stringified annotations
# would stop FastAPI resolving closure-scoped router dependencies.

import httpx
import pytest
from fastapi import FastAPI

from observe_py.client import ObservabilityClient
from observe_py.relay import create_ingest_router
from observe_py.sinks import MemorySink
from observe_py.types import ClientConfig

BROWSER_EVENT = {
    "duration_ms": 42,
    "environment": "production",
    "event": "chat_turn",
    "event_id": "evt_0011223344556677",
    "outcome": "success",
    "runtime": "web",
    "sample_rate": 0.2,
    "sampled": True,
    "schema_version": 1,
    "span_id": "00f067aa0ba902b7",
    "trace_id": "4bf92f3577b34da6a3ce929d0e0e4736",
    "ts": "2026-07-24T00:00:00.000Z",
}


@pytest.fixture
def stack():
    sink = MemorySink()
    # sample_rate=0 proves the relay never re-samples: a success event would be
    # dropped if it went through the normal emit pipeline.
    client = ObservabilityClient(
        ClientConfig(environment="production", sample_rate=0, sinks=(sink,))
    )
    app = FastAPI()
    app.include_router(create_ingest_router(client))
    return app, sink


async def post(app: FastAPI, payload) -> httpx.Response:
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://svc") as http:
        return await http.post("/observe/ingest", json=payload)


async def test_valid_event_is_forwarded_untouched(stack):
    app, sink = stack
    response = await post(app, BROWSER_EVENT)

    assert response.status_code == 202
    assert len(sink.events) == 1
    event = sink.events[0]
    # browser stamps survive: no re-sampling, no re-spanning
    assert event["sample_rate"] == 0.2
    assert event["sampled"] is True
    assert event["span_id"] == BROWSER_EVENT["span_id"]
    assert event["trace_id"] == BROWSER_EVENT["trace_id"]
    assert event["event"] == "chat_turn"


async def test_unknown_event_names_are_accepted(stack):
    app, sink = stack
    response = await post(app, {**BROWSER_EVENT, "event": "never_seen_before"})

    assert response.status_code == 202
    assert sink.events[0]["event"] == "never_seen_before"


async def test_relay_re_redacts(stack):
    app, sink = stack
    response = await post(
        app,
        {**BROWSER_EVENT, "password": "hunter2", "note": "mail jane.doe@example.com"},
    )

    assert response.status_code == 202
    event = sink.events[0]
    assert "password" not in event
    assert event["note"] == "mail [REDACTED:email]"


async def test_invalid_shape_is_rejected(stack):
    app, sink = stack
    missing_trace = {k: v for k, v in BROWSER_EVENT.items() if k != "trace_id"}
    response = await post(app, missing_trace)

    assert response.status_code == 422
    assert sink.events == []


async def test_snake_case_violation_is_rejected(stack):
    app, sink = stack
    response = await post(app, {**BROWSER_EVENT, "Bad_Key": True})

    assert response.status_code == 422
    assert sink.events == []


async def test_coerced_types_are_rejected_at_the_boundary(stack):
    app, sink = stack
    response = await post(app, {**BROWSER_EVENT, "duration_ms": "42"})

    assert response.status_code == 422
    assert sink.events == []


async def test_custom_path():
    sink = MemorySink()
    client = ObservabilityClient(
        ClientConfig(environment="production", sample_rate=0, sinks=(sink,))
    )
    app = FastAPI()
    app.include_router(create_ingest_router(client, path="/telemetry"))

    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://svc") as http:
        response = await http.post("/telemetry", json=BROWSER_EVENT)

    assert response.status_code == 202
    assert len(sink.events) == 1
