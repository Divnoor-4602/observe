# Tinybird delivery — GCP log drain and table design

Two delivery paths by event value, same as the original design: a **cheap fire-and-forget path** for chat/operational events and a **durable path** for events that cost money to lose. Services never talk to Tinybird directly on the cheap path; a single drain service is the one egress, which is also where thorough redaction runs.

## Cheap path: stdout → Cloud Logging → Pub/Sub → drain → Tinybird

```
FastAPI service (stdout sink)
  print(json.dumps({"type": "observability_event", "event": {...}}))
        │  automatic on Cloud Run / GKE
        ▼
Cloud Logging ── Log Router sink, filter:
                 jsonPayload.type = "observability_event"
        ▼
Pub/Sub topic (observability-events)
        │  push subscription with OIDC auth
        ▼
Drain service (Cloud Run, min instances 0)
  1. verify Pub/Sub OIDC token          ← replaces the log-stream HMAC check
  2. parse log entry → wide event JSON
  3. thorough redaction pass            ← the collector-level scrub
  4. envelope allowlist + snake_case validation (schemas/wide-event.schema.json)
  5. batch POST → Tinybird Events API (NDJSON)
        ▼
Tinybird observability_events
```

Notes:

- The Log Router filter keys on the `type` marker, so ordinary application logs never reach the drain.
- Cloud Logging attaches resource labels (service name, revision, instance id) — the drain can backfill `deployment`/`region` if a service omitted them.
- Pub/Sub gives retries + a dead-letter topic for free; a drain deploy going bad does not lose events, it backs them up in the subscription (set retention ≥ 24h).
- The Tinybird Events API is append-only NDJSON over HTTPS with a token — batch by count (500) or bytes (1 MB) or age (2s), whichever first.
- Fire-and-forget end to end: a dropped event on this path is acceptable; that is what the durable path is for.

## Thorough redaction at the drain (defense in depth)

The SDK redactor (TS and Python) is deliberately lightweight — it ships to browsers, so it is a structural net, not a guarantee. The drain is the collector: server-side, centralized, no bundle constraints, runs once for everything entering Tinybird.

- Run a maintained scanning library over every string leaf (the original plan chose [openredaction](https://github.com/sam247/openredaction) for the Cloudflare Worker; on Cloud Run you are not constrained to pure-JS — any maintained PII scanner works, e.g. scrubadub in Python).
- Prefer an **allowlist** for envelope + catalog fields (`schemas/*.json` is machine-readable for exactly this): known keys pass typed, unknown keys survive only into the JSON tail column, and anything matching the denylist is dropped even there.
- This complements the SDK pass, it does not replace it — Sentry receives events before the drain, so the SDK must still scrub.

## Durable path: Cloud Tasks → Tinybird

For `payment_*` / `subscription_*` events. The service's durable sink enqueues a Cloud Task instead of printing:

- **Task name = `event_id`** — Cloud Tasks deduplicates task names, so retries and double-enqueues collapse; `event_id` stays the idempotency key end to end. Note Cloud Tasks task-name dedup has a window (~1h+); for absolute safety the Tinybird table also dedupes by `event_id` at query time (`LIMIT BY event_id`) or via a ReplacingMergeTree.
- The task targets a small authenticated endpoint (drain service route or dedicated handler) that runs the same redaction/validation and POSTs the single event to Tinybird.
- Retry policy: exponential backoff, max attempts high (the send must eventually land), alerting on the dead-letter/failure metric.
- Enqueueing is fast and local — never block the request; enqueue in the sink and return.

## Table design (`observability_events`)

Designed for the open catalog — stable envelope typed, long tail flexible, promote when proven:

```sql
SCHEMA >
    `ts` DateTime64(3) `json:$.ts`,
    `event` LowCardinality(String) `json:$.event`,
    `trace_id` String `json:$.trace_id`,
    `span_id` String `json:$.span_id`,
    `parent_span_id` Nullable(String) `json:$.parent_span_id`,
    `event_id` String `json:$.event_id`,
    `request_id` Nullable(String) `json:$.request_id`,
    `runtime` LowCardinality(String) `json:$.runtime`,
    `service` LowCardinality(Nullable(String)) `json:$.service`,
    `service_version` Nullable(String) `json:$.service_version`,
    `environment` LowCardinality(String) `json:$.environment`,
    `deployment` Nullable(String) `json:$.deployment`,
    `region` Nullable(String) `json:$.region`,
    `route` Nullable(String) `json:$.route`,
    `method` Nullable(String) `json:$.method`,
    `status_code` Nullable(Int32) `json:$.status_code`,
    `outcome` LowCardinality(String) `json:$.outcome`,
    `duration_ms` Float64 `json:$.duration_ms`,
    `sampled` Nullable(UInt8) `json:$.sampled`,
    `sample_rate` Nullable(Float64) `json:$.sample_rate`,
    `schema_version` Int16 `json:$.schema_version`,
    `user_id_hash` Nullable(String) `json:$.user_id_hash`,
    `user_tier` LowCardinality(Nullable(String)) `json:$.user_tier`,
    `session_id` Nullable(String) `json:$.session_id`,
    `auth_status` LowCardinality(Nullable(String)) `json:$.auth_status`,
    `error_type` Nullable(String) `json:$.error.type`,
    `error_code` Nullable(String) `json:$.error.code`,
    `error_message` Nullable(String) `json:$.error.message`,
    `gen_ai_provider` Nullable(String) `json:$.gen_ai.provider.name`,
    `gen_ai_model` Nullable(String) `json:$.gen_ai.request.model`,
    `input_tokens` Nullable(Int64) `json:$.gen_ai.usage.input_tokens`,
    `output_tokens` Nullable(Int64) `json:$.gen_ai.usage.output_tokens`,
    `cost_usd` Nullable(Float64) `json:$.cost_usd`,
    `payload` String `json:$` DEFAULT '{}'

ENGINE "MergeTree"
ENGINE_PARTITION_KEY "toYYYYMM(ts)"
ENGINE_SORTING_KEY "environment, event, ts"
```

`payload` holds the full event JSON — the long tail. When a tail field proves query-worthy, add a materialized column extracting it; no destructive migration, which is why the catalog can stay open.

## Query patterns

Reweighting — every aggregate over sampled data multiplies by `1 / sample_rate`:

```sql
-- true request count and error rate by route
SELECT route,
       sum(1 / coalesce(sample_rate, 1))                        AS requests,
       sumIf(1 / coalesce(sample_rate, 1), outcome = 'error')
         / sum(1 / coalesce(sample_rate, 1))                    AS error_rate
FROM observability_events
WHERE environment = 'production' AND ts > now() - INTERVAL 1 DAY
GROUP BY route
```

Latency percentiles are computed on kept events without reweighting caveats only while `sample_rate = 1`; under head sampling the kept set is an unbiased uniform sample per trace, so `quantile(0.95)(duration_ms)` remains valid — errors being oversampled is the one bias, so filter `outcome = 'success'` for latency SLOs.

Trace lookup (the debugging workhorse):

```sql
SELECT ts, service, event, span_id, parent_span_id, outcome, duration_ms
FROM observability_events
WHERE trace_id = '4bf92f3577b34da6a3ce929d0e0e4736'
ORDER BY ts
```

Cost by model: `sum(cost_usd / coalesce(sample_rate, 1)) GROUP BY gen_ai_model`.

## Launch settings

Start every client at `sample_rate = 1.0` (keep everything). That gives Tinybird unbiased latency distributions to derive real per-route p99s before sampling ever turns on — which is also the prerequisite for the slow-request keep rule (static `slow_ms` threshold as a p99 proxy) planned as the fourth sampling rule. Lower the rate per-service once volume costs justify it.
