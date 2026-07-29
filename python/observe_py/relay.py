"""Browser relay ingest — the client-relay trust boundary from ``docs/python-port.md``.

Browsers cannot hold Tinybird credentials, so the TS client's ``event`` sink
POSTs each kept wide event here. The handler validates against the generated
envelope, then forwards into the same delivery path as server events — no
re-sampling (the browser already decided and stamped ``sampled``/``sample_rate``)
and no new span (a relay is a mail slot, not a hop).

Rate-limiting and request-size caps are deliberately left to the service: this
endpoint is public-facing and must be capped there (spec: "Rate-limit and
size-cap the endpoint").
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Any

from pydantic import ValidationError

from .wide_event import validate_wide_event

if TYPE_CHECKING:
    from fastapi import APIRouter

    from .client import ObservabilityClient


def create_ingest_router(
    client: ObservabilityClient,
    path: str = "/observe/ingest",
) -> APIRouter:
    from fastapi import APIRouter, HTTPException  # lazy: fastapi is an optional extra

    router = APIRouter()

    @router.post(path, status_code=202)
    async def ingest(payload: dict[str, Any]) -> None:
        try:
            validate_wide_event(payload)
        except (ValidationError, ValueError) as err:
            raise HTTPException(status_code=422, detail=str(err)) from err

        client.forward(payload)

    return router
