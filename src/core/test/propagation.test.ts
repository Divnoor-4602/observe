import { describe, expect, it } from 'vitest';

import { newSpanId, newTraceId } from '../identifier.ts';
import {
	formatTraceparent,
	fromRequest,
	parseTraceArg,
	parseTraceparent,
	toTraceArg,
	type TraceContext,
} from '../propagation.ts';

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

describe('toTraceArg', () => {
	it('maps the active span onto snake_case wire keys', () => {
		const arg = toTraceArg({ sampled: true, spanId: VALID_SPAN_ID, traceId: VALID_TRACE_ID });

		expect(arg).toEqual({ parent_span_id: VALID_SPAN_ID, trace_id: VALID_TRACE_ID });
	});

	it('round-trips through parseTraceArg', () => {
		const arg = toTraceArg({ sampled: false, spanId: VALID_SPAN_ID, traceId: VALID_TRACE_ID });

		expect(parseTraceArg(arg)).toEqual(arg);
	});
});

describe('parseTraceArg malformed input', () => {
	it.each([
		null,
		undefined,
		'a string',
		42,
		{},
		{ trace_id: 'not-hex' },
		{ trace_id: VALID_TRACE_ID.toUpperCase() },
		{ trace_id: '0'.repeat(32) },
		{ trace_id: 7 },
		{ parent_span_id: VALID_SPAN_ID },
		{ parent_span_id: 'not-hex', trace_id: VALID_TRACE_ID },
		{ parent_span_id: '0'.repeat(16), trace_id: VALID_TRACE_ID },
		{ parent_span_id: 7, trace_id: VALID_TRACE_ID },
	])('returns null for %#', (value) => {
		expect(parseTraceArg(value)).toBeNull();
	});

	it('accepts a missing parent_span_id', () => {
		expect(parseTraceArg({ trace_id: VALID_TRACE_ID })).toEqual({ trace_id: VALID_TRACE_ID });
	});

	it('strips unknown keys from the parsed result', () => {
		const parsed = parseTraceArg({
			outcome: 'error',
			parent_span_id: VALID_SPAN_ID,
			trace_id: VALID_TRACE_ID,
			user_tier: 'premium',
		});

		expect(parsed).toEqual({ parent_span_id: VALID_SPAN_ID, trace_id: VALID_TRACE_ID });
	});
});

function makeRequest(headers: Record<string, string>) {
	return {
		headers: {
			get: (name: string) => headers[name] ?? null,
		},
	};
}

describe('fromRequest', () => {
	it('reads trace context from the traceparent header', () => {
		const request = makeRequest({ traceparent: `00-${VALID_TRACE_ID}-${VALID_SPAN_ID}-01` });

		expect(fromRequest(request)).toEqual({
			sampled: true,
			spanId: VALID_SPAN_ID,
			traceId: VALID_TRACE_ID,
		});
	});

	it('returns null when the header is missing', () => {
		expect(fromRequest(makeRequest({}))).toBeNull();
	});

	it('returns null when the header is garbage', () => {
		expect(fromRequest(makeRequest({ traceparent: 'nonsense' }))).toBeNull();
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
