# observe

Wide-event observability SDK. One context-rich event per hop, stitched by `trace_id`. The event envelope lives in `src/core/schema.ts`.

This repo is the standalone home of the SDK plus everything the backend team needs to complete the pipeline in Python:

| Where | What |
| ----- | ---- |
| `src/` | The TypeScript SDK (browser / React Native) — the reference implementation |
| `schemas/` | The envelope + event catalog as JSON Schema, generated from the zod source (`bun run generate`) — the cross-language contract |
| `fixtures/` | Golden test data produced by the real TS pipeline (sampling decisions, redaction pairs, normalize pairs, valid/invalid envelopes) — port these into pytest |
| [`docs/python-port.md`](docs/python-port.md) | Full spec for the Python/FastAPI port: engine, ASGI middleware, contextvars ambient API, propagation, GCP delivery |
| [`docs/sentry-python.md`](docs/sentry-python.md) | How the Sentry sink changes on FastAPI (per-request isolation scopes, direct `trace_id` tagging, middleware ordering) |
| [`docs/tinybird.md`](docs/tinybird.md) | Delivery: Cloud Logging → Pub/Sub → drain → Tinybird, durable Cloud Tasks path, table schema, reweighting queries |

The catalog is authored once, in zod (`src/catalog/`). The JSON Schemas are generated artifacts; Python consumes them via `datamodel-code-generator`. Adding an event: add its zod schema to a family file, run `bun run generate`, regenerate the Pydantic models.

## Exports

| Subpath     | What                                                        | Who uses it                             |
| ----------- | ----------------------------------------------------------- | --------------------------------------- |
| `.`         | `obs` API, `installObservability`, id + traceparent helpers | all call sites                          |
| `./client`  | `createObservabilityClient`                                 | app startup (web / RN)                  |
| `./catalog` | `catalog`, `catalogSchema`, `CatalogEvents`                 | emitters + boundary validation          |
| `./schema`  | `wideEventSchema`, `WideEvent`                              | trust boundaries (Convex ingest, drain) |
| `./dev`     | `createConsolePrettySink`, `createMemorySink`               | local dev, tests                        |
| `./sentry`  | `createSentrySink` (enrichment-only, vendor fns injected)   | app startup (web / RN)                  |
| `./types`   | `Sink`, `ClientConfig`, `TraceContext`, …                   | everywhere (types only)                 |

## Quick start

```ts
import { installObservability, obs } from '@ecogpt/observe';
import { createObservabilityClient } from '@ecogpt/observe/client';

const client = createObservabilityClient({
	environment: 'production',
	sampleExemptTiers: ['premium'], // tiers exempt from sampling
	runtime: 'web',
	sampleRate: 0.2, // head ratio for plain success events (default 0.2)
	sinks: [{ name: 'event', send: (event) => post(event) }],
});
installObservability(client);

await obs.withSpan({ event: 'chat_turn', route: 'chat.stream' }, (span) => {
	span.add({ gen_ai: { request: { model: 'gpt-5.5' } } });
	// work — on throw the span records outcome: 'error' and rethrows
});
```

`withInteraction(name, fn)` is the client-side variant that tracks the current span implicitly so nested `obs.add()` calls land on it. Call `client.flush()` before shutdown/stream end to await in-flight sink sends.

## Emit pipeline

Every span runs, in order, at `end()`:

1. **normalize** — scalar leaves only (`Date`→ISO, `bigint`→string, non-finite→`null`, arrays/functions dropped), caps (1024-char strings, 256 fields, depth 6), drops raw-content paths (`gen_ai.input/output/system_instructions`).
2. **sample** — keep/drop decided per event: errors always kept (`sample_rate: 1`), `sampleExemptTiers` always kept (`sample_rate: 1`), everything else a deterministic head ratio hashed from `trace_id` (whole trace agrees). Kept events are stamped `sampled` + `sample_rate`; reweight aggregates in Tinybird by `1 / sample_rate`.
3. **redact** — a fresh scrubbed clone fans out to sinks; the span's own data is untouched. Key denylist (`password`, `api_key`, `secret`, `*_token` — but not `tokens_in`/`tokens_out`) plus value scanners (email, Luhn-valid cards, JWT, `sk_`/`pk_`/`AKIA` keys, IPv4, phone → `[REDACTED:<type>]`). This is a light structural net — thorough redaction runs server-side at the drain.
4. **fan out** — the clone goes to every configured `Sink.send()`; sink failures are isolated and never throw into app code.

## Sentry

`createSentrySink({ addBreadcrumb, setTag, setContext, flush? })` **enriches, never captures** — capture belongs to Sentry's global handlers (client) and Convex's native integration (server). Every kept event becomes a breadcrumb and refreshes the `trace_id` tag; error events add `observe_event`/`route` tags + an `observe` context block. Joins: client Sentry issue ↔ Tinybird via the `trace_id` tag; Convex issue via `request_id` → wide event → `trace_id`.

Error rule: **throw** → automatic everywhere · **catch-and-recover** → Tinybird only · want a stack anyway → add `Sentry.captureException(err)` beside `obs.error(err)` (the catch site has the real `Error`; the pipeline doesn't).

## Event catalog

`event` is an **open string** — unknown events are valid; the catalog types the known ones. Field-sets live per family (`src/catalog/chat.ts`, `payments.ts`) and are composed into one map.

```ts
import { catalog, catalogSchema, type CatalogEvents } from '@ecogpt/observe/catalog';

type ChatTurn = CatalogEvents['chat_turn']; // no per-event z.infer needed

const schema = catalogSchema(catalog, incoming.event); // undefined → unknown event, let it pass
if (schema && !schema.safeParse(incoming).success) reject();
```

Adding an event: add the zod schema to its family file (pin the name with `z.literal`), done — `CatalogEvents` picks it up. New family: new file + spread it into `events` in `src/catalog/index.ts`.

## Field naming

Wide events are queried **by field name**, so names must be consistent. The engine enforces _shape_ (scalar leaves, caps) and _key case_ (validated at the drain); the rules below are the human conventions for choosing names.

- **Style:** lowercase, `snake_case` leaf, dotted namespaces expressed as **nested objects** — `{ gen_ai: { request: { model } } }` is OTel's `gen_ai.request.model`. Keys must match `^[a-z][a-z0-9_]*$`.
- **Use OpenTelemetry names where they exist** (free interop):
  - `gen_ai.request.model`, `gen_ai.response.model`, `gen_ai.provider.name`
  - `gen_ai.usage.input_tokens`, `gen_ai.usage.output_tokens`
  - `gen_ai.operation.name`, `gen_ai.request.temperature`, `gen_ai.request.max_tokens`
  - `http.*`, `service.*`
  - OTel array attributes (e.g. `gen_ai.response.finish_reasons`) are dropped by the scalar-leaf rule — store a scalar form (`finish_reason`).
- **Cost / money:** cost is **not** an OTel attribute — use our own `cost_usd` (or integer `cost_micros` for sub-cent precision). Payment amounts are **integer minor units** (`amount_minor: 4999` = $49.99), never floats.
- **Never emit as fields:** raw prompts/responses (`gen_ai.input.messages`, `gen_ai.output.messages`, `gen_ai.system_instructions`), emails, card numbers, full payloads. The engine drops the raw-content keys and caps field sizes; value-level PII redaction happens on fan-out.
