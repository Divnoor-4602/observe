import { describe, expect, it } from 'vitest';

import { normalize } from '../normalize.ts';

describe('normalize', () => {
	it('recurses into namespaces and keeps scalar leaves', () => {
		const bag: Record<string, unknown> = { payment: { amount_minor: 2000, provider: 'stripe' } };
		normalize(bag);
		expect(bag.payment).toEqual({ amount_minor: 2000, provider: 'stripe' });
	});

	it('drops arrays, functions and symbols', () => {
		const bag: Record<string, unknown> = { fn: () => undefined, list: [1, 2, 3], sym: Symbol('x') };
		normalize(bag);
		expect(bag).toEqual({});
	});

	it('coerces Date to ISO and bigint to string', () => {
		const bag: Record<string, unknown> = { at: new Date('2026-07-13T00:00:00.000Z'), big: 10n };
		normalize(bag);
		expect(bag.at).toBe('2026-07-13T00:00:00.000Z');
		expect(bag.big).toBe('10');
	});

	it('drops undefined but keeps null', () => {
		const bag: Record<string, unknown> = { gone: undefined, kept: null };
		normalize(bag);
		expect('gone' in bag).toBe(false);
		expect(bag.kept).toBeNull();
	});

	it('coerces non-finite numbers to null', () => {
		const bag: Record<string, unknown> = {
			finite: 42,
			negative_infinity: Number.NEGATIVE_INFINITY,
			not_a_number: Number.NaN,
			positive_infinity: Number.POSITIVE_INFINITY,
		};
		normalize(bag);
		expect(bag).toEqual({
			finite: 42,
			negative_infinity: null,
			not_a_number: null,
			positive_infinity: null,
		});
	});

	it('drops non-plain objects', () => {
		const bag: Record<string, unknown> = { m: new Map() };
		normalize(bag);
		expect(bag).toEqual({});
	});

	it('truncates over-long strings', () => {
		const bag: Record<string, unknown> = { long: 'a'.repeat(2000) };
		normalize(bag);
		expect(String(bag.long).endsWith('…')).toBe(true);
		expect(String(bag.long).length).toBeLessThan(2000);
	});

	it('caps the number of fields', () => {
		const bag: Record<string, unknown> = {};
		for (let index = 0; index < 300; index += 1) {
			bag[`f${index}`] = index;
		}
		normalize(bag);
		expect(Object.keys(bag).length).toBe(256);
	});

	it('drops objects deeper than the max depth', () => {
		const bag: Record<string, unknown> = {
			l0: { l1: { l2: { l3: { l4: { l5: { l6: { l7: 'x' } } } } } } },
		};
		normalize(bag);
		expect(JSON.stringify(bag)).toContain('l5');
		expect(JSON.stringify(bag)).not.toContain('l6');
	});

	it('drops forbidden raw-content paths', () => {
		const bag: Record<string, unknown> = {
			gen_ai: { system_instructions: 'secret system prompt' },
		};
		normalize(bag);
		expect(bag.gen_ai).toEqual({});
	});

	it('drops anything under a forbidden namespace, not just exact paths', () => {
		const bag: Record<string, unknown> = { gen_ai: { input: { message: 'raw prompt' } } };
		normalize(bag);
		expect(bag.gen_ai).toEqual({});
	});

	it('does not drop the legitimate error.message field', () => {
		const bag: Record<string, unknown> = { error: { message: 'boom', type: 'Error' } };
		normalize(bag);
		expect(bag.error).toEqual({ message: 'boom', type: 'Error' });
	});
});
