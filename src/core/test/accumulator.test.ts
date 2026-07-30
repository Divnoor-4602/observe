import { afterEach, describe, expect, it, vi } from 'vitest';

import type { WideEvent } from '../schema.ts';

import { Event } from '../accumulator.ts';

function makeEvent(): WideEvent {
	return {
		duration_ms: 0,
		environment: 'development',
		event: 'clock_test',
		event_id: 'evt_0000000000000001',
		outcome: 'success',
		runtime: 'web',
		schema_version: 1,
		span_id: '0'.repeat(15) + '1',
		trace_id: '0'.repeat(31) + '1',
		ts: '2026-07-30T00:00:00.000Z',
	};
}

describe('Event duration', () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it('uses a monotonic clock and clamps a backwards reading to zero', () => {
		vi.spyOn(globalThis.performance, 'now')
			.mockReturnValueOnce(100)
			.mockReturnValueOnce(90);
		const emitted: WideEvent[] = [];
		const event = new Event(
			(value) => emitted.push(value),
			makeEvent(),
			() => {
				throw new Error('not used');
			},
		);

		event.end();

		expect(emitted[0].duration_ms).toBe(0);
	});
});
