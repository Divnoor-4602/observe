import type { WideEvent } from './schema.ts';

const DEFAULT_SAMPLE_RATE = 0.2;
const SAMPLE_HEX_CHARS = 8;
const SAMPLE_BUCKETS = 16 ** SAMPLE_HEX_CHARS;

export type SampleDecision = {
	sampleRate: number;
	shouldKeep: boolean;
};

export function getSampleDecision(
	event: WideEvent,
	rate: number,
	exemptTiers: readonly string[],
): SampleDecision {
	if (event.outcome === 'error') {
		return { sampleRate: 1, shouldKeep: true };
	}

	if (event.user_tier !== undefined && exemptTiers.includes(event.user_tier)) {
		return { sampleRate: 1, shouldKeep: true };
	}

	return { sampleRate: rate, shouldKeep: isSampled(event.trace_id, rate) };
}

export function isSampled(traceId: string, rate: number): boolean {
	if (rate >= 1) {
		return true;
	}

	if (rate <= 0) {
		return false;
	}

	const bucket = Number.parseInt(traceId.slice(0, SAMPLE_HEX_CHARS), 16);
	if (!Number.isFinite(bucket)) {
		return true;
	}

	return bucket < rate * SAMPLE_BUCKETS;
}

export function resolveSampleRate(rate: number | undefined): number {
	if (rate === undefined) {
		return DEFAULT_SAMPLE_RATE;
	}

	if (rate >= 1) {
		return 1;
	}

	if (rate <= 0) {
		return 0;
	}

	return rate;
}
