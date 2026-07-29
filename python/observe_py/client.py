"""ObservabilityClient — twin of ``src/core/client.ts``.

One difference by design (per ``docs/python-port.md``): the TS client tracks the
current span with an internal stack; here the ambient span lives in a
``ContextVar`` (``context.current_span``), which is correct under interleaved
async execution.
"""

from __future__ import annotations

import asyncio
import inspect
import logging
from collections.abc import Awaitable, Iterator
from contextlib import AbstractContextManager, contextmanager
from datetime import UTC, datetime
from typing import Any

from .accumulator import Span
from .context import current_span
from .identifiers import default_random_bytes, new_event_id, new_span_id, new_trace_id
from .redact import redact_event
from .sample import get_sample_decision, resolve_sample_rate
from .types import ClientConfig, Sink
from .wide_event import read_string

_logger = logging.getLogger("observe")

# Optional config fields stamped onto every event; config wins over meta, and an
# unset value erases a meta-provided one (mirrors the TS object-spread order).
_STAMPED_OPTIONAL = ("deployment", "region", "service", "service_version")


class ObservabilityClient:
    def __init__(self, config: ClientConfig) -> None:
        self._config = config
        self._dev = config.environment == "development"
        self._random_bytes = config.random_bytes or default_random_bytes
        self._sample_rate = resolve_sample_rate(config.sample_rate)
        self._pending: set[asyncio.Task[None]] = set()

    def add(self, fields: dict[str, Any]) -> None:
        span = current_span.get()
        if span is not None:
            span.add(fields)

    def begin(self, event: str, /, **meta: Any) -> Span:
        context: dict[str, Any] = {}
        if self._config.get_context is not None:
            try:
                context = self._config.get_context() or {}
            except Exception:
                if self._dev:
                    _logger.warning("[observe] context provider failed", exc_info=True)

        parent = current_span.get()
        explicit_trace_id = read_string(meta.get("trace_id"))
        trace_id = explicit_trace_id if explicit_trace_id is not None else None
        if trace_id is None and parent is not None:
            trace_id = parent.trace_id
        if trace_id is None:
            trace_id = new_trace_id(self._random_bytes)

        explicit_parent_span_id = read_string(meta.get("parent_span_id"))
        parent_span_id = explicit_parent_span_id if explicit_parent_span_id is not None else None
        if parent_span_id is None and parent is not None:
            parent_span_id = parent.span_id

        data: dict[str, Any] = {**context, **meta}
        data.update(
            duration_ms=0,
            environment=self._config.environment,
            event=event,
            event_id=new_event_id(self._random_bytes),
            outcome="success",
            runtime=self._config.runtime,
            schema_version=1,
            span_id=new_span_id(self._random_bytes),
            trace_id=trace_id,
            ts=_now_iso(),
        )
        if parent_span_id is not None:
            data["parent_span_id"] = parent_span_id
        else:
            data.pop("parent_span_id", None)
        for key in _STAMPED_OPTIONAL:
            value = getattr(self._config, key)
            if value is not None:
                data[key] = value
            else:
                data.pop(key, None)

        return Span(self._emit, data, self.begin)

    def error(self, err: object) -> None:
        span = current_span.get()
        if span is not None:
            span.error(err)

    async def flush(self) -> None:
        # Deliveries scheduled while draining must settle before flush resolves.
        while self._pending:
            await asyncio.gather(*tuple(self._pending), return_exceptions=True)

        async def flush_sink(sink: Sink) -> None:
            sink_flush = getattr(sink, "flush", None)
            if sink_flush is None:
                return
            try:
                result = sink_flush()
                if inspect.isawaitable(result):
                    await result
            except Exception:
                if self._dev:
                    _logger.warning("[observe] sink %r flush failed", sink.name, exc_info=True)

        await asyncio.gather(*(flush_sink(sink) for sink in self._config.sinks))

    def interaction(self, name: str) -> AbstractContextManager[Span]:
        return self.span(name)

    @contextmanager
    def span(self, event: str, /, **meta: Any) -> Iterator[Span]:
        span = self.begin(event, **meta)
        token = current_span.set(span)
        try:
            yield span
        except BaseException as err:
            if isinstance(err, asyncio.CancelledError):
                span.add({"outcome": "cancelled"})
            else:
                span.error(err)
            raise
        finally:
            span.end()
            current_span.reset(token)

    def _deliver(self, sink: Sink, event: dict[str, Any]) -> None:
        try:
            result = sink.send(event)
        except Exception:
            if self._dev:
                _logger.warning("[observe] sink %r failed", sink.name, exc_info=True)
            return

        if result is None or not inspect.isawaitable(result):
            return

        settled = self._settle(sink.name, result)
        try:
            loop = asyncio.get_running_loop()
        except RuntimeError:
            # No running loop (scripts, sync CLIs): settle the send inline.
            asyncio.run(settled)
            return

        task = loop.create_task(settled)
        self._pending.add(task)
        task.add_done_callback(self._pending.discard)

    def _emit(self, event: dict[str, Any]) -> None:
        decision = get_sample_decision(event, self._sample_rate, self._config.sample_exempt_tiers)
        if not decision.should_keep:
            return

        event["sample_rate"] = decision.sample_rate
        event["sampled"] = True

        scrubbed = redact_event(event)
        for sink in self._config.sinks:
            self._deliver(sink, scrubbed)

    async def _settle(self, sink_name: str, result: Awaitable[None]) -> None:
        try:
            await result
        except Exception:
            if self._dev:
                _logger.warning("[observe] sink %r failed", sink_name, exc_info=True)


def create_observability_client(config: ClientConfig) -> ObservabilityClient:
    return ObservabilityClient(config)


def _now_iso() -> str:
    return datetime.now(UTC).isoformat(timespec="milliseconds").replace("+00:00", "Z")
