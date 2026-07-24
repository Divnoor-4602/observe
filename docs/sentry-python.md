# Sentry on FastAPI — what changes from the Convex/TS design

The rule carries over unchanged: **the sink enriches, it never captures.** Capture belongs to Sentry's own machinery; our job is making sure every capture carries the wide-event trace identity so Sentry issues and Tinybird rows join on `trace_id`. But the mechanics differ, because Convex and FastAPI sit at opposite ends of a spectrum:

- **Convex** had a native Sentry integration that is dashboard-config only — zero code hooks. We could not tag captures, which forced the indirect join (Convex auto-tags `request_id` → look up the wide event in Tinybird → get `trace_id`).
- **FastAPI has no automatic connection at all until you wire it** — but once you call `sentry_sdk.init()` with `fastapi` installed, the FastAPI/Starlette integration enables itself: unhandled exceptions that produce a 5xx are captured automatically, with request data attached. Because init lives in *our* code, we get the code hooks Convex denied us.

Net effect: the FastAPI setup is **more** work than Convex (one init call per service) and **simpler** at the join (no `request_id` indirection — tag `trace_id` directly on every capture).

## Per-service wiring (each of the three services)

```python
import sentry_sdk

sentry_sdk.init(
    dsn=SERVICE_DSN,
    environment=ENVIRONMENT,          # must match the envelope's environment
    release=SERVICE_VERSION,          # must match service_version
    traces_sample_rate=0,             # no Sentry performance — wide events own timing
    send_default_pii=False,
)
app = FastAPI()
app.add_middleware(ObserveMiddleware, client=obs_client)
```

Ordering matters: `sentry_sdk.init()` runs before the app handles traffic, and Sentry's ASGI wrapper sits **outside** `ObserveMiddleware`. An exception then unwinds inner → outer: our middleware's `finally` runs first (records `outcome="error"`, emits the event, sink stamps the scope), and only then does Sentry capture — so the capture carries the right tags with zero coordination. This is the same free timing the TS design got from `withSpan`'s `finally` running before the rethrow reaches Sentry's global handler.

`failed_request_status_codes` defaults to 5xx-only, which is correct: 4xx are outcomes, not errors — they belong in Tinybird (`status_code` field), not Sentry.

## The sink itself

Port `src/sinks/sentry.ts` with one structural change and one scope-model change.

**Structural:** the TS sink takes injected vendor functions because it ships to browsers where the package must stay vendor-free. In Python, keep the same injection shape (`add_breadcrumb`, `set_tag`, `set_context`, `flush`) for testability — the defaults just bind to `sentry_sdk` top-level functions. No hard dependency: import `sentry_sdk` lazily inside the factory so the package works without Sentry installed.

**Scope model — the real difference.** The JS browser SDK has effectively one global scope per page, which is why the TS sink refreshes the `trace_id` tag on every event ("most-recent-wins accepted trade"). Python `sentry-sdk` 2.x has three scopes (global / isolation / current), and the framework integrations fork an **isolation scope per request**. Top-level `sentry_sdk.set_tag(...)` writes to the current request's isolation scope. Consequences:

- **The most-recent-wins trade disappears server-side.** Tags set during request A never leak onto request B's captures. Strictly better than the client situation.
- **Set `trace_id` at span open, not only at emit.** In TS, tagging at emit time was safe because emit precedes capture. Same holds in Python, but there's a hole: an exception captured mid-request by code that calls `capture_exception` manually, or by an inner library, fires *before* our emit. Since tagging is scope-local and free, the middleware should call `set_tag("trace_id", ...)` (and `set_tag("service", ...)`) immediately after `begin()`. The sink still tags at emit for events outside the middleware (background jobs, child spans) — both writes go to the same isolation scope, idempotently.
- **Breadcrumbs are per-request, not per-session.** In the browser, the breadcrumb trail is a rolling timeline of recent kept events across the whole session — genuinely useful history. On the server, breadcrumbs added to a request's isolation scope attach only to errors in *that request*. So the server-side breadcrumb value is the **intra-request** timeline: `api_ingress` → `model_call` → `persistence` child-span breadcrumbs showing what happened before the failure. That's still worth having; just don't expect session history. (Child spans emit at their own `end()`, during the request, so they land before any late-request error is captured.)

Per kept event, unchanged from TS:

1. `add_breadcrumb(category="observe", message=f"{event} {outcome} {duration_ms}ms", level=...)` — level `error`/`warning`(cancelled)/`info`, data: `trace_id`, `span_id`, `route`.
2. `set_tag("trace_id", ...)`.
3. On `outcome == "error"` additionally: tags `observe_event`, `route`; `set_context("observe", {span_id, error_code, duration_ms, event})`.
4. Every vendor call individually guarded (`try/except: pass`) — a broken Sentry integration must never affect emit.

Background workers (Pub/Sub consumers, Cloud Tasks handlers) don't get the FastAPI integration's per-request isolation scope. Wrap each message handling in `with sentry_sdk.isolation_scope():` so tags/breadcrumbs stay per-message, and tag `trace_id` from the adopted message context at the top.

## Error rule (unchanged, restated for Python)

- **Raise** → automatic everywhere: middleware records the wide event, Sentry integration captures the exception, both share `trace_id`.
- **Catch and recover** → `span.error(err)` (or `obs.error(err)`) only: Tinybird gets the error outcome, Sentry stays quiet. Correct for expected/handled failures.
- **Catch and recover but want a stack** → `sentry_sdk.capture_exception(err)` beside `obs.error(err)` at the catch site — the catch site has the live exception object with its traceback; the pipeline only has serialized strings. The sink must never call `capture_exception` (it would produce stack-less duplicates).

## Flush

`sentry_sdk.flush(timeout=2)` on shutdown, wired into the observability client's `flush()` like the TS sink's optional `flush` passthrough. On Cloud Run this matters: register it in FastAPI's lifespan shutdown so scale-to-zero doesn't drop queued envelopes.

## The joins

- Sentry issue → Tinybird: read the `trace_id` tag, `SELECT * FROM observability_events WHERE trace_id = '...' ORDER BY ts`.
- Tinybird row → Sentry: search `trace_id:<id>` in Sentry — matches client captures, all three services' captures, and background workers, because everyone tags the same way now. The `request_id` indirection from the Convex design is no longer needed, and `sentry_event_id` on the envelope remains manual-capture-only.
