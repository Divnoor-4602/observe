export type TraceContext = {
	sampled: boolean;
	spanId: string;
	traceId: string;
};

export function formatTraceparent(ctx: TraceContext): string {
	const flags = ctx.sampled ? '01' : '00';
	return `00-${ctx.traceId}-${ctx.spanId}-${flags}`;
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

function isValidSpanId(spanId: string): boolean {
	return /^[0-9a-f]{16}$/.test(spanId) && spanId !== '0000000000000000';
}

function isValidTraceId(traceId: string): boolean {
	return /^[0-9a-f]{32}$/.test(traceId) && traceId !== '00000000000000000000000000000000';
}
