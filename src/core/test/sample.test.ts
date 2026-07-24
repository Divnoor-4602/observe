import { describe, expect, it } from 'vitest';

import type { WideEvent } from '../schema.ts';

import { getSampleDecision, isSampled, resolveSampleRate } from '../sample.ts';

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

describe('resolveSampleRate', () => {
	it('defaults to keeping 20% of success events', () => {
		expect(resolveSampleRate(undefined)).toBe(0.2);
	});

	it('clamps out-of-range rates', () => {
		expect(resolveSampleRate(1.5)).toBe(1);
		expect(resolveSampleRate(-0.2)).toBe(0);
		expect(resolveSampleRate(0.25)).toBe(0.25);
	});
});

describe('isSampled', () => {
	it('keeps everything at rate 1 and nothing at rate 0', () => {
		expect(isSampled('f'.repeat(32), 1)).toBe(true);
		expect(isSampled('0'.repeat(32), 0)).toBe(false);
	});

	it('is deterministic per trace_id', () => {
		const traceId = 'abcdef0123456789abcdef0123456789';
		const first = isSampled(traceId, 0.5);
		for (let index = 0; index < 5; index += 1) {
			expect(isSampled(traceId, 0.5)).toBe(first);
		}
	});

	it('buckets by the leading hex chars', () => {
		expect(isSampled('00000000' + 'a'.repeat(24), 0.5)).toBe(true);
		expect(isSampled('ffffffff' + 'a'.repeat(24), 0.5)).toBe(false);
	});

	it('fails open on a malformed trace_id', () => {
		expect(isSampled('zzzz', 0.5)).toBe(true);
	});
});

describe('getSampleDecision', () => {
	it('always keeps errors with sample_rate 1', () => {
		const event = makeEvent({ outcome: 'error', trace_id: 'ffffffff' + 'a'.repeat(24) });
		expect(getSampleDecision(event, 0, [])).toEqual({ sampleRate: 1, shouldKeep: true });
	});

	it('always keeps configured tiers with sample_rate 1', () => {
		const event = makeEvent({ trace_id: 'ffffffff' + 'a'.repeat(24), user_tier: 'premium' });
		expect(getSampleDecision(event, 0, ['premium'])).toEqual({ sampleRate: 1, shouldKeep: true });
	});

	it('head-samples everyone else at the configured rate', () => {
		const kept = makeEvent({ trace_id: '00000000' + 'a'.repeat(24), user_tier: 'free' });
		const dropped = makeEvent({ trace_id: 'ffffffff' + 'a'.repeat(24), user_tier: 'free' });
		expect(getSampleDecision(kept, 0.5, ['premium'])).toEqual({
			sampleRate: 0.5,
			shouldKeep: true,
		});
		expect(getSampleDecision(dropped, 0.5, ['premium'])).toEqual({
			sampleRate: 0.5,
			shouldKeep: false,
		});
	});

	it('does not keep unlisted tiers', () => {
		const event = makeEvent({ trace_id: 'ffffffff' + 'a'.repeat(24), user_tier: 'free' });
		expect(getSampleDecision(event, 0, ['premium']).shouldKeep).toBe(false);
	});
});
