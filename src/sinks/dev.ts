import type { WideEvent } from '../core/schema.ts';
import type { Sink } from '../core/types.ts';

export type MemorySink = Sink & {
	clear: () => void;
	readonly events: WideEvent[];
};

const OUTCOME_MARKS: Record<string, string> = {
	cancelled: '⊘',
	error: '✗',
	success: '✓',
};

export function createConsolePrettySink(name = 'console'): Sink {
	return {
		name,
		send: (event) => {
			try {
				console.info(formatHeader(event), event);
			} catch {
				console.info('[observe]', event);
			}
		},
	};
}

export function createMemorySink(name = 'memory'): MemorySink {
	const events: WideEvent[] = [];

	return {
		clear: () => {
			events.length = 0;
		},
		events,
		name,
		send: (event) => {
			events.push(event);
		},
	};
}

function formatHeader(event: WideEvent): string {
	const mark = OUTCOME_MARKS[event.outcome] ?? '?';
	const trace = event.trace_id.slice(0, 8);
	const span = event.span_id.slice(0, 8);
	return `[observe] ${mark} ${event.event} ${event.duration_ms}ms trace=${trace} span=${span}`;
}
