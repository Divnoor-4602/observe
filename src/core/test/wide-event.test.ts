import { describe, expect, it } from 'vitest';

import { deepMerge } from '../wide-event.ts';

describe('deepMerge', () => {
	it('accumulates a namespace across calls', () => {
		const target: Record<string, unknown> = { payment: { provider: 'stripe' } };
		deepMerge(target, { payment: { status: 'succeeded' } });
		expect(target.payment).toEqual({ provider: 'stripe', status: 'succeeded' });
	});

	it('overwrites a scalar with the last value', () => {
		const target: Record<string, unknown> = { payment: { status: 'pending' } };
		deepMerge(target, { payment: { status: 'succeeded' } });
		expect(target.payment).toEqual({ status: 'succeeded' });
	});

	it('replaces an object when the incoming value is a non-plain object', () => {
		const target: Record<string, unknown> = { at: { old: true } };
		const date = new Date();
		deepMerge(target, { at: date });
		expect(target.at).toBe(date);
	});

	it('replaces with null rather than merging', () => {
		const target: Record<string, unknown> = { a: { x: 1 } };
		deepMerge(target, { a: null });
		expect(target.a).toBeNull();
	});

	it('merges nested objects recursively', () => {
		const target: Record<string, unknown> = { a: { b: { c: 1 } } };
		deepMerge(target, { a: { b: { d: 2 } } });
		expect(target.a).toEqual({ b: { c: 1, d: 2 } });
	});

	it('ignores prototype-polluting keys', () => {
		const target: Record<string, unknown> = {};
		deepMerge(target, { ['__proto__']: { polluted: true } });
		const probe: Record<string, unknown> = {};
		expect(probe.polluted).toBeUndefined();
	});

	it('does not mutate the source object', () => {
		const source = { payment: { provider: 'stripe' } };
		const target: Record<string, unknown> = { payment: { status: 'succeeded' } };
		deepMerge(target, source);
		expect(source.payment).toEqual({ provider: 'stripe' });
	});

	it('merges top-level scalar keys', () => {
		const target: Record<string, unknown> = { model: 'gpt' };
		deepMerge(target, { tokens: 5 });
		expect(target).toEqual({ model: 'gpt', tokens: 5 });
	});
});
