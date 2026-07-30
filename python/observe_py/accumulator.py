"""Span accumulator — twin of the ``Event`` class in ``src/core/accumulator.ts``.

Named ``Span`` per ``docs/python-port.md``; ``end()`` runs normalize and hands the
bag to the client's emit pipeline exactly once.
"""

from __future__ import annotations

import time
from collections.abc import Callable
from typing import Any

from .normalize import normalize
from .wide_event import deep_merge, read_string

BeginChild = Callable[..., "Span"]
Emit = Callable[[dict[str, Any]], None]


class Span:
    def __init__(self, emit: Emit, data: dict[str, Any], begin_child: BeginChild) -> None:
        self._emit = emit
        self._data = data
        self._begin_child = begin_child
        self._ended = False
        self._started_at = time.monotonic()

    @property
    def span_id(self) -> str | None:
        return read_string(self._data.get("span_id"))

    @property
    def trace_id(self) -> str | None:
        return read_string(self._data.get("trace_id"))

    def add(self, fields: dict[str, Any]) -> Span:
        if self._ended:
            return self

        deep_merge(self._data, fields)
        return self

    def child(self, event: str) -> Span:
        return self._begin_child(event, parent_span_id=self.span_id, trace_id=self.trace_id)

    def end(self) -> None:
        if self._ended:
            return
        self._ended = True
        self._data["duration_ms"] = round((time.monotonic() - self._started_at) * 1000, 3)
        normalize(self._data)
        self._emit(self._data)

    def error(self, err: object, fields: dict[str, Any] | None = None) -> Span:
        if self._ended:
            return self

        if fields is not None:
            deep_merge(self._data, fields)
        self._data["outcome"] = "error"
        self._data["error"] = _to_error_fields(err)
        return self


def _to_error_fields(err: object) -> dict[str, str]:
    if isinstance(err, BaseException):
        kind = type(err).__name__
        message = str(err)
    else:
        kind = "UnknownError"
        message = str(err)

    fields = {"message": message, "type": kind}
    code = getattr(err, "code", None)
    if not isinstance(code, str):
        data = getattr(err, "data", None)
        if isinstance(data, dict):
            code = data.get("code")
    if isinstance(code, str):
        fields["code"] = code

    return fields
