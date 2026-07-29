"""Sentry enrichment sink — twin of ``src/sinks/sentry.ts``, adapted per
``docs/sentry-python.md``: enriches, never captures. Vendor callables stay
injectable for tests; defaults bind lazily to ``sentry_sdk`` so the package
works without Sentry installed.
"""

from __future__ import annotations

from collections.abc import Callable
from typing import Any

_BREADCRUMB_LEVELS = {"cancelled": "warning", "error": "error", "success": "info"}


class SentrySink:
    def __init__(
        self,
        add_breadcrumb: Callable[..., Any] | None = None,
        set_tag: Callable[[str, str], Any] | None = None,
        set_context: Callable[[str, dict[str, Any] | None], Any] | None = None,
        flush: Callable[[], Any] | None = None,
        name: str = "sentry",
    ) -> None:
        self.name = name
        if add_breadcrumb is None or set_tag is None or set_context is None:
            import sentry_sdk  # lazy: only needed when defaults are used

            add_breadcrumb = add_breadcrumb or sentry_sdk.add_breadcrumb
            set_tag = set_tag or sentry_sdk.set_tag
            set_context = set_context or sentry_sdk.set_context
            if flush is None:
                flush = lambda: sentry_sdk.flush(timeout=2)  # noqa: E731
        self._add_breadcrumb = add_breadcrumb
        self._set_tag = set_tag
        self._set_context = set_context
        self._flush = flush

    def flush(self) -> Any:
        if self._flush is None:
            return
        try:
            return self._flush()
        except Exception:
            return None  # a broken synchronous integration must never affect emit

    def send(self, event: dict[str, Any]) -> None:
        self._guard(
            lambda: self._add_breadcrumb(
                category="observe",
                data={
                    "route": event.get("route"),
                    "span_id": event.get("span_id"),
                    "trace_id": event.get("trace_id"),
                },
                level=_BREADCRUMB_LEVELS.get(str(event.get("outcome")), "info"),
                message=f"{event.get('event')} {event.get('outcome')} {event.get('duration_ms')}ms",
            )
        )

        self._guard(lambda: self._set_tag("trace_id", str(event.get("trace_id"))))

        if event.get("outcome") != "error":
            return

        self._guard(lambda: self._set_tag("observe_event", str(event.get("event"))))
        if event.get("route") is not None:
            self._guard(lambda: self._set_tag("route", str(event.get("route"))))

        raw_error = event.get("error")
        error: dict[str, Any] = raw_error if isinstance(raw_error, dict) else {}
        self._guard(
            lambda: self._set_context(
                "observe",
                {
                    "duration_ms": event.get("duration_ms"),
                    "error_code": error.get("code"),
                    "event": event.get("event"),
                    "span_id": event.get("span_id"),
                },
            )
        )

    @staticmethod
    def _guard(fn: Callable[[], Any]) -> None:
        try:
            fn()
        except Exception:
            pass  # a broken Sentry integration must never affect emit
