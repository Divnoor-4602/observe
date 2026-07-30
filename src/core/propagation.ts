export type TraceArg = {
	parent_span_id?: string;
	trace_id: string;
};

export type TraceContext = {
	sampled: boolean;
	spanId: string;
	traceId: string;
};

export function formatTraceparent(ctx: TraceContext): string {
	const flags = ctx.sampled ? '01' : '00';
	return `00-${ctx.traceId}-${ctx.spanId}-${flags}`;
}

export function fromRequest(request: {
	headers: { get: (name: string) => null | string };
}): null | TraceContext {
	return parseTraceparent(request.headers.get('traceparent'));
}

export function parseTraceArg(value: unknown): null | TraceArg {
	if (value === null || typeof value !== 'object') {
		return null;
	}

	const traceId = 'trace_id' in value ? value.trace_id : undefined;
	if (typeof traceId !== 'string' || !isValidTraceId(traceId)) {
		return null;
	}

	const parentSpanId = 'parent_span_id' in value ? value.parent_span_id : undefined;
	if (parentSpanId === undefined) {
		return { trace_id: traceId };
	}

	if (typeof parentSpanId !== 'string' || !isValidSpanId(parentSpanId)) {
		return null;
	}

	return { parent_span_id: parentSpanId, trace_id: traceId };
}

export function parseTraceparent(header: null | string | undefined): null | TraceContext {
	if (header === null || header === undefined || header === '') {
		return null;
	}

	const parts = header.split('-');
	if (parts.length !== 4) {
		return null;
	}

	const version = parts[0];
	const traceId = parts[1];
	const spanId = parts[2];
	const traceFlags = parts[3];

	if (version !== '00') {
		return null;
	}

	if (!isValidTraceId(traceId)) {
		return null;
	}

	if (!isValidSpanId(spanId)) {
		return null;
	}

	if (!/^[0-9a-f]{2}$/.test(traceFlags)) {
		return null;
	}

	const flagsByte = Number.parseInt(traceFlags, 16);
	const sampled = (flagsByte & 0x01) === 1;

	return {
		sampled,
		spanId,
		traceId,
	};
}

export function toTraceArg(ctx: TraceContext): TraceArg {
	return { parent_span_id: ctx.spanId, trace_id: ctx.traceId };
}

function isValidSpanId(spanId: string): boolean {
	return /^[0-9a-f]{16}$/.test(spanId) && spanId !== '0000000000000000';
}

function isValidTraceId(traceId: string): boolean {
	return /^[0-9a-f]{32}$/.test(traceId) && traceId !== '00000000000000000000000000000000';
}
