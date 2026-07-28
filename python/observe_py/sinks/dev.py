"""Local dev + test sinks — twin of ``src/sinks/dev.ts``."""

from __future__ import annotations

from typing import Any

_OUTCOME_MARKS = {"cancelled": "⊘", "error": "✗", "success": "✓"}


class ConsolePrettySink:
    def __init__(self, name: str = "console") -> None:
        self.name = name

    def send(self, event: dict[str, Any]) -> None:
        try:
            print(_format_header(event), event)
        except Exception:
            print("[observe]", event)


class MemorySink:
    def __init__(self, name: str = "memory") -> None:
        self.name = name
        self.events: list[dict[str, Any]] = []

    def clear(self) -> None:
        self.events.clear()

    def send(self, event: dict[str, Any]) -> None:
        self.events.append(event)


def _format_header(event: dict[str, Any]) -> str:
    mark = _OUTCOME_MARKS.get(str(event.get("outcome")), "?")
    trace = str(event.get("trace_id", ""))[:8]
    span = str(event.get("span_id", ""))[:8]
    return (
        f"[observe] {mark} {event.get('event')} {event.get('duration_ms')}ms "
        f"trace={trace} span={span}"
    )
