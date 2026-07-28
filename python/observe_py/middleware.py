"""ASGI middleware: one span per HTTP request — per ``docs/python-port.md``.

Raw ASGI (no FastAPI/Starlette import) so any ASGI service can mount it.
``on_begin`` is the vendor-free hook ``docs/sentry-python.md`` calls for: wire it
to ``sentry_sdk.set_tag`` so mid-request captures already carry ``trace_id``.
"""

from __future__ import annotations

import logging
from collections.abc import Awaitable, Callable, MutableMapping
from typing import TYPE_CHECKING, Any

from .context import current_span
from .identifiers import new_request_id
from .propagation import parse_traceparent

if TYPE_CHECKING:
    from .accumulator import Span
    from .client import ObservabilityClient

Scope = MutableMapping[str, Any]
Message = MutableMapping[str, Any]
Receive = Callable[[], Awaitable[Message]]
Send = Callable[[Message], Awaitable[None]]
ASGIApp = Callable[[Scope, Receive, Send], Awaitable[None]]

_logger = logging.getLogger("observe")


class ObserveMiddleware:
    def __init__(
        self,
        app: ASGIApp,
        client: ObservabilityClient,
        on_begin: Callable[[Span], None] | None = None,
    ) -> None:
        self.app = app
        self.client = client
        self.on_begin = on_begin

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return

        parent = parse_traceparent(_header(scope, b"traceparent"))
        span = self.client.begin(
            "api_ingress",
            method=scope["method"],
            parent_span_id=parent.span_id if parent is not None else None,
            request_id=new_request_id(),
            route=f"{scope['method']} {scope['path']}",
            trace_id=parent.trace_id if parent is not None else None,
        )
        if self.on_begin is not None:
            try:
                self.on_begin(span)
            except Exception:
                _logger.warning("[observe] on_begin hook failed", exc_info=True)

        status: dict[str, int | None] = {"code": None}

        async def send_wrapper(message: Message) -> None:
            if message["type"] == "http.response.start":
                status["code"] = message["status"]
            await send(message)

        token = current_span.set(span)
        try:
            await self.app(scope, receive, send_wrapper)
        except Exception as err:
            span.error(err)
            raise  # capture belongs to Sentry's own integration, wrapped outside us
        finally:
            if status["code"] is not None:
                span.add({"status_code": status["code"]})
            span.end()
            current_span.reset(token)


def _header(scope: Scope, name: bytes) -> str | None:
    for key, value in scope.get("headers", ()):
        if key == name:
            return value.decode("latin-1")
    return None
