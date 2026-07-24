import { describe, expect, it } from 'vitest';

import { newSpanId, newTraceId } from '../identifier.ts';
import { formatTraceparent, parseTraceparent, type TraceContext } from '../propagation.ts';

const VALID_TRACE_ID = '4bf92f3577b34da6a3ce929d0e0e4736';
const VALID_SPAN_ID = '00f067aa0ba902b7';

describe('formatTraceparent and parseTraceparent round-trip', () => {
	it.each([
		{ sampled: true, spanId: VALID_SPAN_ID, traceId: VALID_TRACE_ID },
		{ sampled: false, spanId: VALID_SPAN_ID, traceId: VALID_TRACE_ID },
	])('preserves trace context when sampled is $sampled', (ctx: TraceContext) => {
		const header = formatTraceparent(ctx);
		const parsed = parseTraceparent(header);

		expect(parsed).toEqual(ctx);
	});

	it('formats sampled flag as 01 when sampled is true', () => {
		expect(
			formatTraceparent({ sampled: true, spanId: VALID_SPAN_ID, traceId: VALID_TRACE_ID }),
		).toBe(`00-${VALID_TRACE_ID}-${VALID_SPAN_ID}-01`);
	});

	it('formats sampled flag as 00 when sampled is false', () => {
		expect(
			formatTraceparent({ sampled: false, spanId: VALID_SPAN_ID, traceId: VALID_TRACE_ID }),
		).toBe(`00-${VALID_TRACE_ID}-${VALID_SPAN_ID}-00`);
	});
});

describe('parseTraceparent malformed input', () => {
	it.each([
		undefined,
		null,
		'',
		'00',
		'00-abc',
		`00-${VALID_TRACE_ID}`,
		`00-${VALID_TRACE_ID}-${VALID_SPAN_ID}`,
		`00-${VALID_TRACE_ID}-${VALID_SPAN_ID}-01-extra`,
		`ff-${VALID_TRACE_ID}-${VALID_SPAN_ID}-01`,
		`00-${VALID_TRACE_ID.toUpperCase()}-${VALID_SPAN_ID}-01`,
		`00-${VALID_TRACE_ID}-${VALID_SPAN_ID.toUpperCase()}-01`,
		`00-${VALID_TRACE_ID}-${VALID_SPAN_ID}-0G`,
		'00-00000000000000000000000000000000-00f067aa0ba902b7-01',
		'00-4bf92f3577b34da6a3ce929d0e0e4736-0000000000000000-01',
		'00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-1',
		'00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-001',
	])('returns null for %#', (header) => {
		expect(parseTraceparent(header)).toBeNull();
	});
});

describe('identifier integration', () => {
	it('formats and parses freshly generated trace and span ids', () => {
		const ctx: TraceContext = {
			sampled: true,
			spanId: newSpanId(),
			traceId: newTraceId(),
		};

		const parsed = parseTraceparent(formatTraceparent(ctx));
		expect(parsed).toEqual(ctx);
	});
});
