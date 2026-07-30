import { describe, expect, it } from 'vitest';

import type { CatalogEvents } from '../index.ts';

import { catalog, catalogSchema } from '../index.ts';

describe('catalog', () => {
	it('holds exactly the base-stub events for now', () => {
		expect(Object.keys(catalog)).toHaveLength(2);
		expect(catalog).toHaveProperty('chat_turn');
		expect(catalog).toHaveProperty('payment_attempt');
	});

	it('looks up known events and returns undefined for unknown ones', () => {
		expect(catalogSchema(catalog, 'chat_turn')).toBeDefined();
		expect(catalogSchema(catalog, 'payment_attempt')).toBeDefined();
		expect(catalogSchema(catalog, 'nope')).toBeUndefined();
	});

	it('does not resolve inherited property names as catalog events', () => {
		expect(catalogSchema(catalog, 'toString')).toBeUndefined();
	});

	it('validates a chat_turn against its stub schema', () => {
		const schema = catalogSchema(catalog, 'chat_turn');
		const valid = schema?.safeParse({
			event: 'chat_turn',
			gen_ai: { provider: { name: 'openai' }, request: { model: 'gpt-5.5' } },
		});
		const invalid = schema?.safeParse({ event: 'chat_turn', gen_ai: { provider: 'openai' } });

		expect(valid?.success).toBe(true);
		expect(invalid?.success).toBe(false);
	});

	it('exposes each event type by indexed access without a per-event infer', () => {
		const turn: CatalogEvents['chat_turn'] = {
			event: 'chat_turn',
			gen_ai: { provider: { name: 'openai' }, request: { model: 'gpt-5.5' } },
		};
		const attempt: CatalogEvents['payment_attempt'] = {
			event: 'payment_attempt',
			payment: { amount_minor: 4999, currency: 'USD', processor: 'stripe', status: 'succeeded' },
		};

		expect(turn.event).toBe('chat_turn');
		expect(attempt.payment.amount_minor).toBe(4999);
	});

	it('validates a payment_attempt against its stub schema', () => {
		const schema = catalogSchema(catalog, 'payment_attempt');
		const valid = schema?.safeParse({
			event: 'payment_attempt',
			payment: { amount_minor: 4999, currency: 'USD', processor: 'stripe', status: 'succeeded' },
		});
		const invalid = schema?.safeParse({
			event: 'payment_attempt',
			payment: { amount_minor: '4999' },
		});

		expect(valid?.success).toBe(true);
		expect(invalid?.success).toBe(false);
	});

	it('rejects fractional payment minor units', () => {
		const schema = catalogSchema(catalog, 'payment_attempt');
		const result = schema?.safeParse({
			event: 'payment_attempt',
			payment: {
				amount_minor: 49.99,
				currency: 'USD',
				processor: 'stripe',
				status: 'succeeded',
			},
		});

		expect(result?.success).toBe(false);
	});
});
