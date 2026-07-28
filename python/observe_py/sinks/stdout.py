"""stdout JSON sink — the cheap GCP delivery path (``docs/tinybird.md``).

One line per event; the ``observability_event`` marker is what the Log Router
filter keys on, so ordinary application logs never reach the drain.
"""

from __future__ import annotations

import json
from typing import Any


class StdoutJsonSink:
    def __init__(self, name: str = "stdout") -> None:
        self.name = name

    def send(self, event: dict[str, Any]) -> None:
        line = json.dumps(
            {"event": event, "type": "observability_event"},
            default=str,
            separators=(",", ":"),
        )
        print(line, flush=True)
