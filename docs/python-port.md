# Python port — engine spec and FastAPI adapter

This document is the contract for `observe-py`, the Python twin of the TypeScript SDK in `src/`. The TS package stays the frontend SDK (browser / React Native). The Python package covers the FastAPI services. Both emit the same wide-event JSON into the same Tinybird table, stitched by `trace_id`.

The TS source is the reference implementation. When this doc and the TS code disagree, the TS code wins — and this doc should be fixed.

## The model in one paragraph

One context-rich event per request or service hop, not scattered log lines. A span opens when a hop starts, context accumulates onto an in-memory bag while the hop runs (`obs.add`), and exactly one event emits when it ends — success, error, or throw. Hops link through `trace_id` (whole journey) / `span_id` (this hop) / `parent_span_id` (the hop that caused it). Events are queried by field name in Tinybird, so field names are law (see README "Field naming"); event names are open strings.

## Suggested package layout

```
observe_py/
├── envelope.py        # generated Pydantic models (see "Contract artifacts")
├── accumulator.py     # Span: add / error / child / end
├── client.py          # ObservabilityClient: begin / emit pipeline / flush
├── context.py         # contextvars ambient API: obs.add() without a handle
├── normalize.py       # scalar-leaf coercion + caps
├── sample.py          # deterministic head sampling
├── redact.py          # denylist + value scanners, on a clone
├── propagation.py     # W3C traceparent format/parse
├── identifiers.py     # trace/span/event/request id generation
├── middleware.py      # ASGI middleware: one span per request
├── httpx_transport.py # outbound propagation
└── sinks/             # stdout JSON, Sentry enrichment, memory (tests)
```

## Contract artifacts (start here)

- `schemas/wide-event.schema.json` — the envelope, generated from the zod source. Generate Pydantic models from it with `datamodel-code-generator`; do not hand-write the envelope.
- `schemas/catalog.schema.json` — field-sets for known events (`chat_turn`, `payment_attempt`, …). The catalog is **open**: an event with no schema is valid. Validate only when a schema exists.
- `fixtures/*.json` — golden outputs produced by running the actual TS pipeline. Port these into pytest:
  - `envelope-valid.json` / `envelope-invalid.json` — must pass / must fail your envelope validation.
  - `sampling.json` — `(trace_id, rate) → should_keep` pairs; your sampler must agree exactly (this is what keeps a trace all-kept or all-dropped across TS and Python).
  - `redaction.json` — input/output event pairs through the redactor.
  - `normalize.json` — input/output pairs through normalize (JSON-representable cases; the non-JSON coercions are specified below).

Regenerate artifacts after any zod change: `bun run generate`. CI should fail if `git diff` is dirty afterward — that is the drift alarm.

The zod files in `src/catalog/` remain the single authoring point for the catalog. Adding an event: add the zod schema there, regenerate, re-run `datamodel-code-generator` on the Python side.

## Engine spec

Emit pipeline at `end()`, in order: **normalize → sample → redact → fan out**. Every stage must match the TS behavior:

### Normalize (`normalize.py`, reference `src/core/normalize.ts`)

- Leaves must be scalars. Coerce: `datetime` → ISO-8601 string, `int` beyond float precision is fine in Python (emit as number; the TS `bigint → string` rule exists for JS reasons), non-finite floats (`nan`, `inf`) → `null`, `Decimal` → float or string consistently (prefer: never emit `Decimal`; money is integer minor units).
- Drop: lists, tuples, sets, functions, arbitrary objects, `None`-valued keys? No — **keep explicit `null`, drop only missing/undefined-equivalents** (in Python: keep `None`, there is no undefined).
- Caps: strings truncated to **1024** chars + `…` marker, max **256** leaf fields per event, max nesting depth **6** (deeper objects dropped).
- Forbidden paths dropped regardless of content: `gen_ai.input`, `gen_ai.output`, `gen_ai.system_instructions` (and everything under them). Raw prompts/responses never enter telemetry — pointers (`conversation_id`, `message_id`), template versions, and hashes only.

### Sample (`sample.py`, reference `src/core/sample.ts`)

```python
SAMPLE_HEX_CHARS = 8
SAMPLE_BUCKETS = 16 ** SAMPLE_HEX_CHARS

def is_sampled(trace_id: str, rate: float) -> bool:
    if rate >= 1: return True
    if rate <= 0: return False
    try:
        bucket = int(trace_id[:SAMPLE_HEX_CHARS], 16)
    except ValueError:
        return True
    return bucket < rate * SAMPLE_BUCKETS
```

Keep rules, in order: `outcome == "error"` → keep, `sample_rate = 1`; `user_tier` in the client's `sample_exempt_tiers` → keep, `sample_rate = 1`; otherwise the head ratio above, stamping `sampled = True` and `sample_rate = rate` on kept events. Dropped events are simply not emitted. Because the decision is a pure function of `trace_id`, the browser and all three services agree without coordination.

### Redact (`redact.py`, reference `src/core/redact.ts`)

Runs on a **deep copy**; the span's own data is never mutated. Two layers:

- Key denylist (drop the whole field): `api_key`, `authorization`, `card_number`, `credit_card`, `cvv`, `password`, `secret`, `ssn`, and any key ending `_token`. Must NOT catch `tokens_in` / `tokens_out`.
- Value scanners over every string leaf, replacing matches with `[REDACTED:<type>]`: JWT (`eyJ…`), `sk_`/`pk_` keys, AWS `AKIA…`, email, credit card (Luhn-validated to cut false positives), IPv4, phone. Port the regexes from `src/core/redact.ts` verbatim; the fixtures will catch drift.

This is the light structural net. The thorough pass runs centrally at the drain (see `docs/tinybird.md`) — do not skip the SDK pass anyway, because the Sentry sink receives events before the drain exists in the path.

### Identifiers and propagation (reference `src/core/identifier.ts`, `src/core/propagation.ts`)

- `trace_id`: 32 lowercase hex chars (16 bytes, `secrets.token_bytes`), `span_id`: 16 hex chars, `event_id`: `evt_` + 16 hex, `request_id`: `req_` + 16 hex. All-zero ids are invalid.
- `traceparent`: `00-{trace_id}-{span_id}-{flags}`, flags `01` = sampled. Parse strictly per W3C: reject wrong version, wrong lengths, non-hex, all-zero ids — return `None`, then mint a fresh trace.

## FastAPI adapter

### One span per request: ASGI middleware

```python
class ObserveMiddleware:
    def __init__(self, app, client: ObservabilityClient):
        self.app, self.client = app, client

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            return await self.app(scope, receive, send)
        parent = parse_traceparent(get_header(scope, "traceparent"))
        span = self.client.begin(
            event="api_ingress",
            route=f'{scope["method"]} {scope["path"]}',
            method=scope["method"],
            trace_id=parent.trace_id if parent else None,
            parent_span_id=parent.span_id if parent else None,
        )
        token = current_span.set(span)   # contextvar
        status = {"code": None}
        try:
            await self.app(scope, receive, wrap_send(send, status))
        except Exception as err:
            span.error(err)
            raise                        # Sentry's integration captures it after us
        finally:
            span.add({"status_code": status["code"]})
            span.end()
            current_span.reset(token)
```

Key properties to preserve:

- `end()` in `finally` — exactly one event per request, including on crash.
- The exception is **re-raised** — capture belongs to Sentry's own integration (see `docs/sentry-python.md`), the span only records `outcome/error.*`.
- Middleware ordering: Sentry's ASGI middleware must wrap **outside** this one, so our `finally` (which stamps the Sentry scope with `trace_id`) runs before Sentry captures. In practice: call `sentry_sdk.init()` before adding `ObserveMiddleware`; Sentry auto-wraps the outermost app.

### Ambient API via contextvars

`current_span: ContextVar[Span | None]` gives Python what Convex never could: deep code calls `obs.add({...})` with no handle, and it lands on the request's span. `contextvars` propagate correctly through `await`, `asyncio.gather`, and FastAPI dependencies. `span.child("model_call")` for sub-spans (same trace, `parent_span_id` = request span) around LLM calls, DB writes, tool calls.

`obs.add` with no active span is a silent no-op; `begin`-style entry points raise if the client is not installed — mirror `src/index.ts`.

### Outbound propagation

- **Service → service (httpx):** an `httpx.AsyncClient` event hook or transport wrapper that injects `traceparent` built from the current span (`format_traceparent(trace_id, span_id, sampled)`). The receiving service's middleware adopts it. Optionally emit a client-side hop event around the call so slow downstreams are visible from both ends.
- **Background work (Pub/Sub, Cloud Tasks, cron):** no HTTP request to carry the header — put `traceparent` in the message **attributes** / task payload at publish time; the consumer's entry point parses it and `begin`s with the adopted identity, `function_type="background"`. No context in the message → mint a fresh trace.

### Client relay ingest

Browsers cannot hold Tinybird credentials. The web/RN client's `event` sink POSTs its wide events to one FastAPI endpoint, e.g. `POST /observe/ingest`:

- Validate the body against the envelope (generated Pydantic model) — this is the trust boundary the `./schema` export serves in TS; reject snake_case violations and shape errors, accept unknown event names.
- Do not re-sample (the client already decided; kept events arrive stamped) and do not re-open a span — just forward into the same delivery path as server events.
- Rate-limit and size-cap the endpoint; it is public-facing.

## Delivery on GCP (fan out targets)

Each service's client is configured with sinks at startup, same as TS. Recommended set:

1. **stdout sink** (the cheap path): `print(json.dumps({"type": "observability_event", "event": event}))` — one line, no newlines inside. On Cloud Run this lands in Cloud Logging automatically. A Log Router sink filters `jsonPayload.type="observability_event"` → Pub/Sub → the drain service → Tinybird. Details in `docs/tinybird.md`.
2. **Sentry enrichment sink**: breadcrumbs + tags, never captures. Details in `docs/sentry-python.md`.
3. **memory sink** for tests, **pretty console sink** for local dev (port of `src/sinks/dev.ts`).

Durable path for high-value events (payments): instead of stdout, the sink enqueues a **Cloud Task** whose task name is the `event_id` (built-in dedupe) targeting a small handler that POSTs to the Tinybird Events API with retries. Never block the request on the network send — enqueue and return. Policy: `payment_*` / `subscription_*` events → durable path; everything else → stdout path.

Sink failures must never raise into request code, and never log the event body on failure (that would bypass redaction review). `client.flush()` drains pending deliveries — call it on FastAPI shutdown and before Cloud Run instances exit.

## Client config (mirror `src/core/types.ts`)

`runtime="python"` (added to the envelope enum for this port), `service` (one of your three service names — this is how services are distinguished in Tinybird), `service_version`, `environment`, `deployment`, `region` (from GCP metadata), `sinks`, `sample_rate` (default 0.2; launch at 1.0 until volume justifies lowering — see ECO-622 rationale), `sample_exempt_tiers`, `get_context()` for per-event ambient fields (instance id, region).

## Definition of done for the port

- All fixture files pass in pytest (envelope, sampling, redaction, normalize).
- A request through the middleware emits exactly one valid envelope event; a raised exception emits one event with `outcome="error"` and `error.type/message` populated, then reaches Sentry with the `trace_id` tag attached.
- A browser-originated `traceparent` survives client → service A → service B, three hop events sharing one `trace_id`.
- A `chat_turn` with `gen_ai.*` fields validates against `schemas/catalog.schema.json`.
- Sampling agreement: for the fixture trace_ids, Python and TS make identical keep decisions.
