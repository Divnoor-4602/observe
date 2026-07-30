import { afterEach, describe, expect, it, vi } from 'vitest';

import { createLogStreamSink } from '../log-stream.ts';

function makeEvent() {
	return {
		duration_ms: 42,
		environment: 'production' as const,
		event: 'chat_turn',
		event_id: 'evt_0000000000000001',
		outcome: 'success' as const,
		runtime: 'convex' as const,
		schema_version: 1 as const,
		span_id: '0'.repeat(15) + '1',
		trace_id: '0'.repeat(31) + '1',
		ts: '2026-07-26T00:00:00.000Z',
	};
}

describe('createLogStreamSink', () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it('emits one marked compact JSON line per event', () => {
		const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);
		const event = makeEvent();

		void createLogStreamSink().send(event);

		expect(info).toHaveBeenCalledTimes(1);
		const line = info.mock.calls[0][0] as string;
		expect(line).not.toContain('\n');
		expect(JSON.parse(line)).toEqual({ event, type: 'observability_event' });
	});
});
