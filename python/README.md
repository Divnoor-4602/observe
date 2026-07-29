# observe-py

The Python/FastAPI twin of the TypeScript SDK in [`../src`](../src). Spec:
[`../docs/python-port.md`](../docs/python-port.md) — same envelope, same emit
pipeline (normalize → sample → redact → fan out), same golden fixtures, one
wide event per hop stitched by `trace_id`.

The TS source is the reference implementation. The contract artifacts
([`../schemas`](../schemas), [`../fixtures`](../fixtures)) are generated from
the zod source; `observe_py/envelope.py` is generated from
`schemas/wide-event.schema.json` — never hand-edited. After any zod change:
`bun run generate`, then `scripts/generate-envelope.sh`, then re-run both test
suites — the fixtures are the drift alarm.

## Wiring a FastAPI service

```python
import sentry_sdk
from fastapi import FastAPI
from observe_py.client import ObservabilityClient
from observe_py.context import install_observability, obs, observed
from observe_py.httpx_transport import inject_traceparent
from observe_py.middleware import ObserveMiddleware
from observe_py.sinks import SentrySink, StdoutJsonSink
from observe_py.types import ClientConfig

client = ObservabilityClient(
    ClientConfig(
        environment="production",
        service="server-layer",  # how services are distinguished in Tinybird
        sample_rate=1.0,  # launch at 1.0; lower per-service later
        sample_exempt_tiers=("premium",),
        sinks=(StdoutJsonSink(), SentrySink()),
    )
)
install_observability(client)

sentry_sdk.init(...)  # before middleware: Sentry wraps outside us
app = FastAPI()
app.add_middleware(
    ObserveMiddleware,
    client=client,
    # per docs/sentry-python.md: tag the isolation scope at span open so
    # mid-request captures already carry the trace identity
    on_begin=lambda span: (
        sentry_sdk.set_tag("trace_id", span.trace_id),
        sentry_sdk.set_tag("service", "server-layer"),
    ),
)
# call `await client.flush()` in lifespan shutdown
```

Everything else is ambient — no handles threaded through code:

```python
async def current_user(token: TokenDep) -> User:
    user = await resolve(token)
    obs.add({"user_id_hash": user.id_hash, "user_tier": user.tier})  # lands on the request span
    return user


@observed("model_call")  # child span, parent inferred from context
async def call_model(prompt_ref: str) -> Result:
    obs.add({"gen_ai": {"request": {"model": "claude-fable-5"}}})
    ...
```

Outbound propagation (service → service), once on the shared client:

```python
ed_client = httpx.AsyncClient(base_url=ED_URL, event_hooks={"request": [inject_traceparent]})
```

Background consumers (Pub/Sub, Cloud Tasks): read `traceparent` from message
attributes, `parse_traceparent(...)`, and pass the ids to `client.begin(...)`.

## Parity notes

- Explicit empty-string trace and parent-span IDs win over an ambient parent, matching
  TypeScript's `??` behavior; ignoring falsy IDs would be safer.
- Sampling emulates JavaScript `Number.parseInt` by accepting a leading hexadecimal
  prefix. Rejecting malformed IDs outright would be safer.
- `deep_merge` drops `__proto__` and `constructor` solely for cross-language parity
  with the TypeScript prototype-pollution guard.
- Python emits durations as floating-point milliseconds for better server timing;
  TypeScript emits integer milliseconds.
- Python maps `CancelledError` to `outcome="cancelled"` without `error.*`. JavaScript
  has no equivalent cancellation concept, so TypeScript marks every throw as an error.
- Crashed requests omit `status_code` instead of emitting `null`; explicit null is
  rejected by the TypeScript zod envelope, despite the buggy snippet in the spec doc.

## Layout

Mirrors the suggested layout in the spec: `envelope.py` (generated),
`accumulator.py`, `client.py`, `context.py` (contextvars ambient API),
`normalize.py`, `sample.py`, `redact.py`, `propagation.py`, `identifiers.py`,
`middleware.py` (raw ASGI), `httpx_transport.py`, `sinks/` (stdout JSON,
Sentry enrichment, memory, pretty console). Core dependency: `pydantic` only;
httpx/sentry are optional extras.

One deliberate divergence from TS: the current span lives in a `ContextVar`
instead of a client-internal stack, so interleaved async requests can never
cross-contaminate (see `test_concurrent_spans_do_not_cross_contaminate`).

## Tests

```bash
cd python
uv sync
uv run pytest        # includes the golden fixture conformance suite
uv run ruff check .
```

The fixture tests (`../fixtures/*.json`) are the cross-language conformance
gate: sampling decisions, redaction pairs, normalize pairs, and envelope
validity must agree with the TS pipeline exactly.
