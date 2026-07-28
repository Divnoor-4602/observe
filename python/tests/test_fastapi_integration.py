"""Definition-of-done integration (docs/python-port.md): a browser-minted
traceparent survives client → server → downstream as linked hop events, with
ambient enrichment from FastAPI dependencies and outbound httpx propagation."""

# NOTE: no `from __future__ import annotations` here — stringified annotations
# would stop FastAPI resolving Depends() on closure-scoped fixture dependencies.

from typing import Annotated

import httpx
import pytest
from fastapi import Depends, FastAPI

from observe_py.client import ObservabilityClient
from observe_py.context import install_observability, obs, observed
from observe_py.httpx_transport import inject_traceparent
from observe_py.middleware import ObserveMiddleware
from observe_py.propagation import parse_traceparent
from observe_py.sinks import MemorySink
from observe_py.types import ClientConfig
from observe_py.wide_event import validate_wide_event

BROWSER_TRACE = "4bf92f3577b34da6a3ce929d0e0e4736"
BROWSER_SPAN = "00f067aa0ba902b7"


@pytest.fixture
def stack():
    sink = MemorySink()
    client = ObservabilityClient(
        ClientConfig(
            environment="production",
            sample_rate=1,
            service="server-layer",
            sinks=(sink,),
        )
    )
    install_observability(client)

    downstream_headers: list[dict[str, str]] = []

    def fake_ed(request: httpx.Request) -> httpx.Response:
        downstream_headers.append(dict(request.headers))
        return httpx.Response(200, json={"answer": 42})

    ed_client = httpx.AsyncClient(
        transport=httpx.MockTransport(fake_ed),
        base_url="http://ed",
        event_hooks={"request": [inject_traceparent]},
    )

    async def current_user() -> str:
        obs.add({"user_tier": "premium", "auth_status": "authenticated"})
        return "user-1"

    @observed("ed_call")
    async def call_ed() -> int:
        response = await ed_client.post("/infer")
        obs.add({"ed_status": response.status_code})
        return response.json()["answer"]

    app = FastAPI()

    @app.post("/chat")
    async def chat(user: Annotated[str, Depends(current_user)]) -> dict[str, int]:
        return {"answer": await call_ed()}

    app.add_middleware(ObserveMiddleware, client=client)
    return app, sink, downstream_headers, client


async def test_trace_survives_all_hops(stack):
    app, sink, downstream_headers, client = stack

    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://svc") as http:
        response = await http.post(
            "/chat", headers={"traceparent": f"00-{BROWSER_TRACE}-{BROWSER_SPAN}-01"}
        )
    await client.flush()

    assert response.status_code == 200
    assert len(sink.events) == 2

    ed_event, ingress_event = sink.events
    for event in sink.events:
        validate_wide_event(event)

    # hop chain: browser span → ingress span → ed_call span
    assert ingress_event["event"] == "api_ingress"
    assert ingress_event["trace_id"] == BROWSER_TRACE
    assert ingress_event["parent_span_id"] == BROWSER_SPAN
    assert ed_event["event"] == "ed_call"
    assert ed_event["trace_id"] == BROWSER_TRACE
    assert ed_event["parent_span_id"] == ingress_event["span_id"]

    # dependency enrichment landed on the request span, not the child
    assert ingress_event["user_tier"] == "premium"
    assert ed_event["ed_status"] == 200

    # outbound hop carried the ed_call span's identity downstream
    parsed = parse_traceparent(downstream_headers[0]["traceparent"])
    assert parsed is not None
    assert parsed.trace_id == BROWSER_TRACE
    assert parsed.span_id == ed_event["span_id"]
