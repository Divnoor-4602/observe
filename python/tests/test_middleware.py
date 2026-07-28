"""ASGI middleware behavior — one event per request, adoption, error path."""

from __future__ import annotations

import httpx
import pytest

from observe_py.client import ObservabilityClient
from observe_py.context import obs
from observe_py.middleware import ObserveMiddleware
from observe_py.sinks import MemorySink
from observe_py.types import ClientConfig

TRACE_ID = "4bf92f3577b34da6a3ce929d0e0e4736"
SPAN_ID = "00f067aa0ba902b7"


async def plain_app(scope, receive, send) -> None:
    if scope["path"] == "/boom":
        raise RuntimeError("handler exploded")
    obs.add({"handler_field": "landed"})
    await send({"type": "http.response.start", "status": 201, "headers": []})
    await send({"type": "http.response.body", "body": b"ok"})


def make_stack() -> tuple[ObserveMiddleware, MemorySink]:
    sink = MemorySink()
    client = ObservabilityClient(
        ClientConfig(environment="production", sample_rate=1, sinks=(sink,))
    )
    return ObserveMiddleware(plain_app, client=client), sink


async def request(
    app: ObserveMiddleware, path: str = "/", headers: dict | None = None
) -> httpx.Response:
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://svc") as http:
        return await http.get(path, headers=headers or {})


async def test_one_event_per_request():
    app, sink = make_stack()
    response = await request(app)

    assert response.status_code == 201
    assert len(sink.events) == 1
    event = sink.events[0]
    assert event["event"] == "api_ingress"
    assert event["route"] == "GET /"
    assert event["method"] == "GET"
    assert event["status_code"] == 201
    assert event["outcome"] == "success"
    assert event["request_id"].startswith("req_")
    assert event["handler_field"] == "landed"  # ambient obs.add reached the request span


async def test_traceparent_adoption():
    app, sink = make_stack()
    await request(app, headers={"traceparent": f"00-{TRACE_ID}-{SPAN_ID}-01"})

    event = sink.events[0]
    assert event["trace_id"] == TRACE_ID
    assert event["parent_span_id"] == SPAN_ID


async def test_invalid_traceparent_mints_fresh_trace():
    app, sink = make_stack()
    await request(app, headers={"traceparent": "00-zzz-abc-01"})

    event = sink.events[0]
    assert event["trace_id"] != "zzz"
    assert len(event["trace_id"]) == 32
    assert "parent_span_id" not in event


async def test_exception_records_error_and_reraises():
    app, sink = make_stack()
    with pytest.raises(RuntimeError, match="handler exploded"):
        await request(app, path="/boom")

    assert len(sink.events) == 1
    event = sink.events[0]
    assert event["outcome"] == "error"
    assert event["error"]["type"] == "RuntimeError"
    assert "status_code" not in event


async def test_on_begin_hook_receives_span_and_failures_are_contained():
    seen = []
    sink = MemorySink()
    client = ObservabilityClient(
        ClientConfig(environment="production", sample_rate=1, sinks=(sink,))
    )

    def hook(span) -> None:
        seen.append(span.trace_id)
        raise RuntimeError("sentry down")

    app = ObserveMiddleware(plain_app, client=client, on_begin=hook)
    response = await request(app)

    assert response.status_code == 201
    assert seen == [sink.events[0]["trace_id"]]


async def test_non_http_scopes_pass_through():
    called = []

    async def lifespan_app(scope, receive, send) -> None:
        called.append(scope["type"])

    sink = MemorySink()
    client = ObservabilityClient(
        ClientConfig(environment="production", sample_rate=1, sinks=(sink,))
    )
    app = ObserveMiddleware(lifespan_app, client=client)
    await app({"type": "lifespan"}, None, None)

    assert called == ["lifespan"]
    assert sink.events == []
