import { describe, expect, it } from 'vitest';

import type { WideEvent } from '../schema.ts';

import { redactEvent } from '../redact.ts';

function makeEvent(overrides: Partial<WideEvent> = {}): WideEvent {
	return {
		duration_ms: 10,
		environment: 'development',
		event: 'op',
		event_id: 'evt_0000000000000001',
		outcome: 'success',
		runtime: 'web',
		schema_version: 1,
		span_id: '0'.repeat(15) + '1',
		trace_id: '0'.repeat(31) + '1',
		ts: '2026-07-21T00:00:00.000Z',
		...overrides,
	};
}

describe('key denylist', () => {
	it('drops denied leaf keys anywhere in the event', () => {
		const event = makeEvent({
			password: 'hunter2',
			stripe: { api_key: 'sk_live_abc', provider: 'stripe' },
		});

		const scrubbed = redactEvent(event);

		expect('password' in scrubbed).toBe(false);
		expect(scrubbed.stripe).toEqual({ provider: 'stripe' });
	});

	it('drops *_token keys but keeps the tokens_in/tokens_out counts', () => {
		const event = makeEvent({
			access_token: 'abc123',
			refresh_token: 'def456',
			tokens_in: 1200,
			tokens_out: 450,
		});

		const scrubbed = redactEvent(event);

		expect('access_token' in scrubbed).toBe(false);
		expect('refresh_token' in scrubbed).toBe(false);
		expect(scrubbed.tokens_in).toBe(1200);
		expect(scrubbed.tokens_out).toBe(450);
	});
});

describe('value scanners', () => {
	it('masks emails inside string values', () => {
		const scrubbed = redactEvent(makeEvent({ note: 'contact user@example.com for details' }));
		expect(scrubbed.note).toBe('contact [REDACTED:email] for details');
	});

	it('masks JWTs', () => {
		const scrubbed = redactEvent(
			makeEvent({ note: 'bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.dQw4w9WgXcQ' }),
		);
		expect(scrubbed.note).toBe('bearer [REDACTED:jwt]');
	});

	it('masks api keys', () => {
		const scrubbed = redactEvent(
			makeEvent({ note: 'used sk_live_4242424242 and AKIAIOSFODNN7EXAMPLE' }),
		);
		expect(scrubbed.note).toBe('used [REDACTED:api_key] and [REDACTED:api_key]');
	});

	it('masks a Luhn-valid card number but not an invalid one', () => {
		const scrubbed = redactEvent(
			makeEvent({
				invalid: 'num 4111 1111 1111 1112',
				valid: 'card 4111 1111 1111 1111',
			}),
		);
		expect(scrubbed.valid).toBe('card [REDACTED:credit_card]');
		expect(scrubbed.invalid).toBe('num 4111 1111 1111 1112');
	});

	it('masks IPv4 addresses', () => {
		const scrubbed = redactEvent(makeEvent({ note: 'from 192.168.1.100' }));
		expect(scrubbed.note).toBe('from [REDACTED:ipv4]');
	});

	it('masks international phone numbers', () => {
		const scrubbed = redactEvent(makeEvent({ note: 'call +1 415-555-2671 now' }));
		expect(scrubbed.note).toBe('call [REDACTED:phone] now');
	});

	it('leaves ordinary numeric fields alone', () => {
		const scrubbed = redactEvent(makeEvent({ cost_usd: 0.018, note: 'retried 3 times' }));
		expect(scrubbed.cost_usd).toBe(0.018);
		expect(scrubbed.note).toBe('retried 3 times');
	});
});

describe('non-destructive clone', () => {
	it('returns a fresh clone and leaves the source event untouched', () => {
		const event = makeEvent({
			gen_ai: { request: { model: 'gpt-5.5' } },
			note: 'user@example.com',
			password: 'hunter2',
		});

		const scrubbed = redactEvent(event);

		expect(scrubbed).not.toBe(event);
		expect(scrubbed.gen_ai).not.toBe(event.gen_ai);
		expect(event.note).toBe('user@example.com');
		expect(event.password).toBe('hunter2');
		expect(scrubbed.gen_ai).toEqual({ request: { model: 'gpt-5.5' } });
	});
});
