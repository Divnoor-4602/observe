import { afterEach, describe, expect, it } from 'vitest';

import { newEventId, newRequestId, newSpanId, newTraceId } from '../identifier.ts';

const ALL_ZERO_TRACE_ID = '00000000000000000000000000000000';
const ALL_ZERO_SPAN_ID = '0000000000000000';

const fill =
	(value: number) =>
	(bytes: Uint8Array): void => {
		bytes.fill(value);
	};

describe('newTraceId', () => {
	it('returns 32 lowercase hex characters', () => {
		const traceId = newTraceId();
		expect(traceId).toMatch(/^[0-9a-f]{32}$/);
	});

	it('never returns all zeros', () => {
		for (let index = 0; index < 20; index += 1) {
			expect(newTraceId()).not.toBe(ALL_ZERO_TRACE_ID);
		}
	});

	it('returns different ids on each call', () => {
		const first = newTraceId();
		const second = newTraceId();
		expect(first).not.toBe(second);
	});
});

describe('newSpanId', () => {
	it('returns 16 lowercase hex characters', () => {
		const spanId = newSpanId();
		expect(spanId).toMatch(/^[0-9a-f]{16}$/);
	});

	it('never returns all zeros', () => {
		for (let index = 0; index < 20; index += 1) {
			expect(newSpanId()).not.toBe(ALL_ZERO_SPAN_ID);
		}
	});

	it('returns different ids on each call', () => {
		const first = newSpanId();
		const second = newSpanId();
		expect(first).not.toBe(second);
	});
});

describe('newEventId', () => {
	it('returns evt_ prefix with 16 lowercase hex characters', () => {
		const eventId = newEventId();
		expect(eventId).toMatch(/^evt_[0-9a-f]{16}$/);
	});
});

describe('newRequestId', () => {
	it('returns req_ prefix with 16 lowercase hex characters', () => {
		const requestId = newRequestId();
		expect(requestId).toMatch(/^req_[0-9a-f]{16}$/);
	});
});

describe('injected rng', () => {
	it('uses the injected source for trace and span ids', () => {
		expect(newTraceId(fill(0xab))).toBe('ab'.repeat(16));
		expect(newSpanId(fill(0xcd))).toBe('cd'.repeat(8));
	});

	it('prefixes injected event and request ids', () => {
		expect(newEventId(fill(0x01))).toBe(`evt_${'01'.repeat(8)}`);
		expect(newRequestId(fill(0x02))).toBe(`req_${'02'.repeat(8)}`);
	});

	it('is deterministic for a given source', () => {
		expect(newTraceId(fill(0x12))).toBe(newTraceId(fill(0x12)));
	});

	it('applies the non-zero guard even when the source returns all zeros', () => {
		expect(newSpanId(fill(0))).toBe('0000000000000001');
		expect(newTraceId(fill(0))).toBe(`${'00'.repeat(15)}01`);
	});
});

describe('random fallback', () => {
	const originalCrypto = globalThis.crypto;

	afterEach(() => {
		Object.defineProperty(globalThis, 'crypto', {
			configurable: true,
			value: originalCrypto,
			writable: true,
		});
	});

	it('still returns valid non-zero ids when crypto is unavailable', () => {
		Object.defineProperty(globalThis, 'crypto', {
			configurable: true,
			value: undefined,
			writable: true,
		});

		const traceId = newTraceId();
		const spanId = newSpanId();

		expect(traceId).toMatch(/^[0-9a-f]{32}$/);
		expect(traceId).not.toBe(ALL_ZERO_TRACE_ID);
		expect(spanId).toMatch(/^[0-9a-f]{16}$/);
		expect(spanId).not.toBe(ALL_ZERO_SPAN_ID);
	});

	it('still returns valid ids when getRandomValues is missing', () => {
		Object.defineProperty(globalThis, 'crypto', {
			configurable: true,
			value: {},
			writable: true,
		});

		expect(newTraceId()).toMatch(/^[0-9a-f]{32}$/);
		expect(newSpanId()).toMatch(/^[0-9a-f]{16}$/);
	});
});
