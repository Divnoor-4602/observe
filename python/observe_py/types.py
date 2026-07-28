"""Shared client types — the Python twin of ``src/core/types.ts``."""

from __future__ import annotations

from collections.abc import Awaitable, Callable
from typing import Any, Literal, Protocol, runtime_checkable

from pydantic import BaseModel, ConfigDict

RandomBytes = Callable[[int], bytes]
"""Return ``count`` random bytes. Injectable for deterministic tests."""


@runtime_checkable
class Sink(Protocol):
    """Structural twin of the TS ``Sink``. ``flush`` is optional — the client
    discovers it with ``getattr``, mirroring the optional TS field."""

    name: str

    def send(self, event: dict[str, Any]) -> Awaitable[None] | None: ...


class ClientConfig(BaseModel):
    model_config = ConfigDict(arbitrary_types_allowed=True)

    deployment: str | None = None
    environment: Literal["development", "production", "staging"] = "development"
    get_context: Callable[[], dict[str, Any]] | None = None
    random_bytes: RandomBytes | None = None
    region: str | None = None
    runtime: str = "python"
    sample_exempt_tiers: tuple[str, ...] = ()
    sample_rate: float | None = None
    service: str | None = None
    service_version: str | None = None
    sinks: tuple[Sink, ...]
