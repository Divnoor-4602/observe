"""Three-hop browser → server → ed propagation through two ASGI services."""

# NOTE: no `from __future__ import annotations` here — stringified annotations
# would stop FastAPI resolving Depends() on closure-scoped fixture dependencies.

from typing import Annotated

import httpx
import pytest
from fastapi import Depends, FastAPI

from observe_py.client import ObservabilityClient
from observe_py.context import install_observability, obs
from observe_py.httpx_transport import inject_traceparent
from observe_py.middleware import ObserveMiddleware
from observe_py.sinks import MemorySink
from observe_py.types import ClientConfig
from observe_py.wide_event import validate_wide_event

BROWSER_TRACE = "4bf92f3577b34da6a3ce929d0e0e4736"
BROWSER_SPAN = "00f067aa0ba902b7"


@pytest.fixture
def stack():
    server_sink = MemorySink()
    server_client = ObservabilityClient(
        ClientConfig(
            environment="production",
            sample_rate=1,
            service="server",
            sinks=(server_sink,),
        )
    )
    install_observability(server_client)

    ed_sink = MemorySink()
    ed_client = ObservabilityClient(
        ClientConfig(environment="production", sample_rate=1, service="ed", sinks=(ed_sink,))
    )
    ed_app = FastAPI()

    @ed_app.post("/infer")
    async def infer() -> dict[str, int]:
        return {"answer": 42}

    ed_app.add_middleware(ObserveMiddleware, client=ed_client)
    downstream_http = httpx.AsyncClient(
        transport=httpx.ASGITransport(app=ed_app),
        base_url="http://ed",
        event_hooks={"request": [inject_traceparent]},
    )

    async def current_user() -> str:
        obs.add({"user_tier": "premium", "auth_status": "authenticated"})
        return "user-1"

    async def call_ed() -> int:
        response = await downstream_http.post("/infer")
        obs.add({"ed_status": response.status_code})
        return response.json()["answer"]

    app = FastAPI()

    @app.post("/chat")
    async def chat(user: Annotated[str, Depends(current_user)]) -> dict[str, int]:
        return {"answer": await call_ed()}

    app.add_middleware(ObserveMiddleware, client=server_client)
    return app, server_sink, ed_sink, server_client, ed_client, downstream_http


async def test_trace_survives_all_hops(stack):
    app, server_sink, ed_sink, server_client, ed_client, downstream_http = stack

    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://svc") as http:
        response = await http.post(
            "/chat", headers={"traceparent": f"00-{BROWSER_TRACE}-{BROWSER_SPAN}-01"}
        )
    await downstream_http.aclose()
    await server_client.flush()
    await ed_client.flush()

    assert response.status_code == 200
    browser_event = {
        "duration_ms": 1.0,
        "environment": "production",
        "event": "browser_request",
        "event_id": "evt_0011223344556677",
        "outcome": "success",
        "runtime": "web",
        "schema_version": 1,
        "span_id": BROWSER_SPAN,
        "trace_id": BROWSER_TRACE,
        "ts": "2026-07-24T00:00:00.000Z",
    }
    assert len(server_sink.events) == 1
    assert len(ed_sink.events) == 1
    ingress_event = server_sink.events[0]
    ed_event = ed_sink.events[0]
    events = [browser_event, ingress_event, ed_event]
    for event in events:
        validate_wide_event(event)

    # hop chain: browser span → server ingress span → ed ingress span
    assert ingress_event["event"] == "api_ingress"
    assert ingress_event["service"] == "server"
    assert ingress_event["trace_id"] == BROWSER_TRACE
    assert ingress_event["parent_span_id"] == BROWSER_SPAN
    assert ed_event["event"] == "api_ingress"
    assert ed_event["service"] == "ed"
    assert ed_event["trace_id"] == BROWSER_TRACE
    assert ed_event["parent_span_id"] == ingress_event["span_id"]
    assert {event["trace_id"] for event in events} == {BROWSER_TRACE}

    assert ingress_event["user_tier"] == "premium"
    assert ingress_event["ed_status"] == 200
