import type { TraceArg } from './propagation.ts';
import type { WideEvent } from './schema';
import type { BeginMeta } from './types.ts';

import { normalize } from './normalize.ts';
import { deepMerge, readString } from './wide-event.ts';

export type BeginChild = (meta: BeginMeta) => Event;
export type Emit = (event: WideEvent) => void;

const perf: undefined | { now?: () => number } = globalThis.performance;

export class Event {
	get spanId(): string | undefined {
		return readString(this.#data.span_id);
	}
	get traceId(): string | undefined {
		return readString(this.#data.trace_id);
	}
	readonly #beginChild: BeginChild;
	readonly #data: WideEvent;
	readonly #emit: Emit;
	#ended = false;
	readonly #startedAt: number;

	constructor(emit: Emit, event: WideEvent, beginChild: BeginChild) {
		this.#emit = emit;
		this.#data = event;
		this.#beginChild = beginChild;
		this.#startedAt = monotonicNow();
	}

	add = (fields: Partial<WideEvent>): this => {
		if (this.#ended) {
			return this;
		}

		deepMerge(this.#data, fields);
		return this;
	};

	child = (event: string): Event => {
		return this.#beginChild({ event, parent_span_id: this.spanId, trace_id: this.traceId });
	};

	end = (): void => {
		if (this.#ended) return;
		this.#ended = true;
		this.#data.duration_ms = Math.max(0, Math.round(monotonicNow() - this.#startedAt));
		normalize(this.#data);
		this.#emit(this.#data);
	};

	error = (err: unknown, fields?: Partial<WideEvent>): this => {
		if (this.#ended) {
			return this;
		}

		if (fields !== undefined) {
			deepMerge(this.#data, fields);
		}
		this.#data.outcome = 'error';
		this.#data.error = toErrorFields(err);
		return this;
	};

	// Total because begin() assigns both ids unconditionally when constructing the
	// envelope; a future Event path that defers id assignment would reintroduce
	// undefined behind this signature and break required-trace callees.
	traceArg = (): TraceArg => {
		return { parent_span_id: this.#data.span_id, trace_id: this.#data.trace_id };
	};
}

function monotonicNow(): number {
	return perf?.now === undefined ? Date.now() : perf.now();
}

function readErrorCode(err: object): string | undefined {
	if ('code' in err && typeof err.code === 'string') {
		return err.code;
	}

	if ('data' in err && err.data !== null && typeof err.data === 'object' && 'code' in err.data) {
		return typeof err.data.code === 'string' ? err.data.code : undefined;
	}

	return undefined;
}

function toErrorFields(err: unknown): { code?: string; message?: string; type: string } {
	const type = err instanceof Error ? err.name : 'UnknownError';
	const message = err instanceof Error ? err.message : String(err);
	const code = err !== null && typeof err === 'object' ? readErrorCode(err) : undefined;
	if (code !== undefined) {
		return { code, message, type };
	}

	return { message, type };
}
