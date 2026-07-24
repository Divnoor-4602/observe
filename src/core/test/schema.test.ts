import { describe, expect, it } from 'vitest';

import { wideEventSchema } from '../schema.ts';

const validEvent = {
	duration_ms: 12,
	environment: 'development',
	event: 'chat_send',
	event_id: 'evt_0123456789abcdef',
	outcome: 'success',
	runtime: 'web',
	schema_version: 1,
	span_id: '0123456789abcdef',
	trace_id: '0123456789abcdef0123456789abcdef',
	ts: '2026-07-13T00:00:00.000Z',
};

describe('wideEventSchema', () => {
	it('accepts a fully-populated envelope', () => {
		expect(wideEventSchema.safeParse(validEvent).success).toBe(true);
	});

	it('rejects an event missing a required field', () => {
		const { schema_version: version, ...withoutVersion } = validEvent;
		expect(version).toBe(1);
		expect(wideEventSchema.safeParse(withoutVersion).success).toBe(false);
	});

	it('allows extra feature keys via catchall', () => {
		const parsed = wideEventSchema.safeParse({ ...validEvent, model: 'gpt-5.5', tokens_in: 100 });
		expect(parsed.success).toBe(true);
	});

	it('validates the nested error namespace', () => {
		const parsed = wideEventSchema.safeParse({
			...validEvent,
			error: { message: 'boom', type: 'ProviderTimeoutError' },
			outcome: 'error',
		});
		expect(parsed.success).toBe(true);
	});

	it('rejects an unknown enum value', () => {
		expect(wideEventSchema.safeParse({ ...validEvent, runtime: 'desktop' }).success).toBe(false);
	});

	it('rejects a wrong schema_version', () => {
		expect(wideEventSchema.safeParse({ ...validEvent, schema_version: 2 }).success).toBe(false);
	});

	it('rejects a camelCase key (naming guardrail)', () => {
		expect(wideEventSchema.safeParse({ ...validEvent, tokensIn: 5 }).success).toBe(false);
	});
});
