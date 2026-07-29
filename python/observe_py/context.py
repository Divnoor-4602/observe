"""Ambient API via contextvars — the Python twin of ``src/index.ts``.

``contextvars`` propagate correctly through ``await``, ``asyncio.gather`` and
FastAPI dependencies, so deep code calls ``obs.add({...})`` with no handle and
it lands on the request's span.
"""

from __future__ import annotations

import functools
import inspect
from contextlib import AbstractContextManager
from contextvars import ContextVar
from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:
    from collections.abc import Callable

    from .accumulator import Span
    from .client import ObservabilityClient

current_span: ContextVar[Span | None] = ContextVar("observe_current_span", default=None)

_installed: ObservabilityClient | None = None


def install_observability(client: ObservabilityClient) -> None:
    global _installed
    _installed = client


def get_client() -> ObservabilityClient:
    if _installed is None:
        raise RuntimeError(
            "[observe] no client installed — call install_observability(client) at startup"
        )
    return _installed


class _Obs:
    """Mirror of the TS ``obs`` object: add/error are no-ops without an active
    span; entry points (``begin``/``span``) raise without an installed client."""

    def add(self, fields: dict[str, Any]) -> None:
        span = current_span.get()
        if span is not None:
            span.add(fields)

    def begin(self, event: str, /, **meta: Any) -> Span:
        return get_client().begin(event, **meta)

    def error(self, err: object) -> None:
        span = current_span.get()
        if span is not None:
            span.error(err)

    def interaction(self, name: str) -> AbstractContextManager[Span]:
        return get_client().span(name)

    def span(self, event: str, /, **meta: Any) -> AbstractContextManager[Span]:
        return get_client().span(event, **meta)


obs = _Obs()


def observed(event: str) -> Callable[[Callable[..., Any]], Callable[..., Any]]:
    """Wrap a function in a span — the ``withSpan`` twin for service functions.

    Nesting is automatic: the client infers the parent from ``current_span``.
    """

    def decorate(fn: Callable[..., Any]) -> Callable[..., Any]:
        if inspect.iscoroutinefunction(fn):

            @functools.wraps(fn)
            async def async_wrapper(*args: Any, **kwargs: Any) -> Any:
                with get_client().span(event):
                    return await fn(*args, **kwargs)

            return async_wrapper

        @functools.wraps(fn)
        def sync_wrapper(*args: Any, **kwargs: Any) -> Any:
            with get_client().span(event):
                return fn(*args, **kwargs)

        return sync_wrapper

    return decorate
