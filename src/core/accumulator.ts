import type { WideEvent } from './schema';
import type { BeginMeta } from './types.ts';

import { normalize } from './normalize.ts';
import { deepMerge, readString } from './wide-event.ts';

export type BeginChild = (meta: BeginMeta) => Event;
export type Emit = (event: WideEvent) => void;

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
		this.#startedAt = Date.now();
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
		this.#data.duration_ms = Date.now() - this.#startedAt;
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
}

function toErrorFields(err: unknown): { code?: string; message?: string; type: string } {
	const type = err instanceof Error ? err.name : 'UnknownError';
	const message = err instanceof Error ? err.message : String(err);
	if (err !== null && typeof err === 'object' && 'code' in err && typeof err.code === 'string') {
		return { code: err.code, message, type };
	}

	return { message, type };
}
