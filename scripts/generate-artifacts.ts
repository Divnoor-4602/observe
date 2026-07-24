import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { z } from 'zod';

import { catalog } from '../src/catalog/index.ts';
import { normalize } from '../src/core/normalize.ts';
import { redactEvent } from '../src/core/redact.ts';
import { isSampled } from '../src/core/sample.ts';
import { type WideEvent, wideEventSchema } from '../src/core/schema.ts';

const ROOT = join(import.meta.dirname, '..');
const SCHEMAS = join(ROOT, 'schemas');
const FIXTURES = join(ROOT, 'fixtures');

mkdirSync(SCHEMAS, { recursive: true });
mkdirSync(FIXTURES, { recursive: true });

const KEY_PATTERN = '^[a-z][a-z0-9_]*$';

function write(path: string, value: unknown): void {
	writeFileSync(path, `${JSON.stringify(value, null, '\t')}\n`);
	console.info(`wrote ${path.replace(`${ROOT}/`, '')}`);
}

const envelopeSchema = z.toJSONSchema(wideEventSchema, { io: 'input' }) as Record<string, unknown>;
envelopeSchema.$id = 'https://ecogpt.dev/schemas/wide-event.schema.json';
envelopeSchema.title = 'WideEvent';
envelopeSchema.description =
	'The envelope every wide event carries. Extra keys are allowed (open catalog); all keys recursively must match the snake_case pattern.';
envelopeSchema.propertyNames = { pattern: KEY_PATTERN };
write(join(SCHEMAS, 'wide-event.schema.json'), envelopeSchema);

const catalogEvents: Record<string, unknown> = {};
for (const [event, schema] of Object.entries(catalog)) {
	const json = z.toJSONSchema(schema, { io: 'input' }) as Record<string, unknown>;
	json.title = event;
	catalogEvents[event] = json;
}
write(join(SCHEMAS, 'catalog.schema.json'), {
	$id: 'https://ecogpt.dev/schemas/catalog.schema.json',
	description:
		'Field-set schemas for known events, keyed by event name. Events absent from this map are still valid — the catalog is open; validate only when a schema exists.',
	events: catalogEvents,
});

function envelope(overrides: Partial<WideEvent>): WideEvent {
	return {
		duration_ms: 42,
		environment: 'production',
		event: 'chat_turn',
		event_id: 'evt_0011223344556677',
		outcome: 'success',
		runtime: 'web',
		schema_version: 1,
		span_id: '00f067aa0ba902b7',
		trace_id: '4bf92f3577b34da6a3ce929d0e0e4736',
		ts: '2026-07-24T00:00:00.000Z',
		...overrides,
	};
}

const validEnvelopes = [
	envelope({}),
	envelope({
		error: { code: 'RATE_LIMITED', message: 'model provider rate limit', type: 'AppError' },
		event: 'model_call',
		outcome: 'error',
		parent_span_id: '00f067aa0ba902b7',
		request_id: 'req_8899aabbccddeeff',
		route: 'chat.stream',
		runtime: 'convex',
		sample_rate: 1,
		sampled: true,
		span_id: '11f067aa0ba902b8',
	}),
	envelope({
		gen_ai: {
			provider: { name: 'anthropic' },
			request: { model: 'claude-fable-5' },
			usage: { input_tokens: 812, output_tokens: 213 },
		},
		sample_rate: 0.2,
		sampled: true,
		user_tier: 'free',
	}),
	envelope({
		event: 'payment_attempt',
		payment: { amount_minor: 4999, currency: 'USD', processor: 'stripe', status: 'success' },
		sample_rate: 1,
		sampled: true,
		user_tier: 'premium',
	}),
];
for (const fixture of validEnvelopes) {
	const parsed = wideEventSchema.safeParse(fixture);
	if (!parsed.success) {
		throw new Error(`fixture failed envelope validation: ${parsed.error.message}`);
	}
}
write(join(FIXTURES, 'envelope-valid.json'), validEnvelopes);

const missingTraceId = (() => {
	const { trace_id: _, ...rest } = envelope({});
	return rest;
})();
const invalidEnvelopes: unknown[] = [
	{ ...envelope({}), Bad_Key: true },
	{ ...envelope({}), nested: { 'kebab-case': 1 } },
	missingTraceId,
	{ ...envelope({}), outcome: 'unknown' },
	{ ...envelope({}), schema_version: 2 },
];
for (const fixture of invalidEnvelopes) {
	if (wideEventSchema.safeParse(fixture).success) {
		throw new Error(`invalid fixture unexpectedly passed validation: ${JSON.stringify(fixture)}`);
	}
}
write(join(FIXTURES, 'envelope-invalid.json'), invalidEnvelopes);

const sampleRates = [0.01, 0.1, 0.2, 0.5];
const traceIds = [
	'00000000a3ce929d0e0e4736aabbccdd',
	'0ccccccca3ce929d0e0e4736aabbccdd',
	'19999999a3ce929d0e0e4736aabbccdd',
	'33333332a3ce929d0e0e4736aabbccdd',
	'4bf92f3577b34da6a3ce929d0e0e4736',
	'7fffffffa3ce929d0e0e4736aabbccdd',
	'80000000a3ce929d0e0e4736aabbccdd',
	'cafebabea3ce929d0e0e4736aabbccdd',
	'deadbeefa3ce929d0e0e4736aabbccdd',
	'ffffffffa3ce929d0e0e4736aabbccdd',
];
write(join(FIXTURES, 'sampling.json'), {
	algorithm:
		'bucket = int(trace_id[0:8], 16); keep when bucket < rate * 16**8. Errors and exempt tiers bypass with sample_rate 1.',
	cases: traceIds.flatMap((traceId) =>
		sampleRates.map((rate) => ({ rate, should_keep: isSampled(traceId, rate), trace_id: traceId })),
	),
});

const redactionInputs: WideEvent[] = [
	envelope({
		access_token: 'super-secret-value',
		api_key: 'sk_live_abcdef123456',
		gen_ai: { usage: { input_tokens: 100, output_tokens: 50 } },
		tokens_in: 100,
		tokens_out: 50,
	}),
	envelope({
		note: 'contact me at jane.doe@example.com or +1 (415) 555-0100',
		server: { ip: 'client was 203.0.113.42 today' },
	}),
	envelope({
		payment: {
			card_number: '4111111111111111',
			memo: 'card 4111 1111 1111 1111 approved, fake 1234567890123 ignored',
		},
	}),
	envelope({
		auth: {
			jwt: 'bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U',
		},
		keys: 'sk_fakekey1234567890abcdef and AKIAIOSFODNN7EXAMPLE',
	}),
];
write(
	join(FIXTURES, 'redaction.json'),
	redactionInputs.map((input) => ({ input, output: redactEvent(input) })),
);

const normalizeInputs: Record<string, unknown>[] = [
	{
		gen_ai: {
			input: { messages: 'raw prompt must not survive' },
			output: { messages: 'raw response must not survive' },
			request: { model: 'claude-fable-5' },
			system_instructions: 'raw system prompt must not survive',
		},
	},
	{ drop_array: [1, 2, 3], keep_null: null, kept: 'value' },
	{ long_string: 'a'.repeat(1500) },
	{ d1: { d2: { d3: { d4: { d5: { d6: { kept: 1, too_deep: { dropped: 1 } } } } } } } },
];
write(
	join(FIXTURES, 'normalize.json'),
	normalizeInputs.map((input) => {
		const live = structuredClone(input);
		normalize(live);
		return { input, output: live };
	}),
);
