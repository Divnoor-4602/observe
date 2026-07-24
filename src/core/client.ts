import type { WideEvent } from './schema.ts';
import type { BeginMeta, ClientConfig, RandomBytes, Sink } from './types.ts';

import { type Emit, Event } from './accumulator.ts';
import { defaultRandomBytes, newEventId, newSpanId, newTraceId } from './identifier.ts';
import { redactEvent } from './redact.ts';
import { getSampleDecision, resolveSampleRate } from './sample.ts';
import { readString } from './wide-event.ts';

export class ObservabilityClient {
	readonly #deployment?: string;
	readonly #dev: boolean;
	readonly #environment: 'development' | 'production' | 'staging';
	readonly #getContext?: () => Record<string, unknown>;
	readonly #pending = new Set<Promise<void>>();
	readonly #randomBytes: RandomBytes;
	readonly #region?: string;
	readonly #runtime: 'react_native' | 'web';
	readonly #sampleExemptTiers: readonly string[];
	readonly #sampleRate: number;
	readonly #service?: string;
	readonly #serviceVersion?: string;
	readonly #sinks: Sink[];
	readonly #stack: Event[] = [];

	constructor(config: ClientConfig) {
		this.#sinks = config.sinks;
		this.#getContext = config.getContext;
		this.#randomBytes = config.randomBytes ?? defaultRandomBytes;
		this.#environment = config.environment ?? 'development';
		this.#dev = this.#environment === 'development';
		this.#runtime = config.runtime;
		this.#sampleRate = resolveSampleRate(config.sampleRate);
		this.#sampleExemptTiers = config.sampleExemptTiers ?? [];
		this.#service = config.service;
		this.#serviceVersion = config.serviceVersion;
		this.#deployment = config.deployment;
		this.#region = config.region;
	}

	add = (fields: Partial<WideEvent>): void => {
		this.#current()?.add(fields);
	};

	begin = (meta: BeginMeta): Event => {
		let context: Record<string, unknown> = {};
		try {
			context = this.#getContext?.() ?? {};
		} catch (err) {
			if (this.#dev) {
				console.warn('[observe] context provider failed', err);
			}
		}

		const parent = this.#current();
		const traceId = readString(meta.trace_id) ?? parent?.traceId ?? newTraceId(this.#randomBytes);
		const parentSpanId = readString(meta.parent_span_id) ?? parent?.spanId;

		const data: WideEvent = {
			...context,
			...meta,
			deployment: this.#deployment,
			duration_ms: 0,
			environment: this.#environment,
			event: meta.event,
			event_id: newEventId(this.#randomBytes),
			outcome: 'success',
			parent_span_id: parentSpanId,
			region: this.#region,
			runtime: this.#runtime,
			schema_version: 1,
			service: this.#service,
			service_version: this.#serviceVersion,
			span_id: newSpanId(this.#randomBytes),
			trace_id: traceId,
			ts: new Date().toISOString(),
		};

		return new Event(this.#emit, data, this.begin);
	};

	error = (err: unknown): void => {
		this.#current()?.error(err);
	};

	async flush(): Promise<void> {
		while (this.#pending.size > 0) {
			// oxlint-disable-next-line no-await-in-loop -- deliveries scheduled during the drain must settle before flush resolves.
			await Promise.allSettled(this.#pending);
		}
		await Promise.allSettled(this.#sinks.map((sink) => Promise.resolve(sink.flush?.())));
	}

	withInteraction = <T>(name: string, fn: () => Promise<T> | T): Promise<T> => {
		return this.#run({ event: name }, fn);
	};

	withSpan = <T>(meta: BeginMeta, fn: (event: Event) => Promise<T> | T): Promise<T> => {
		return this.#run(meta, fn);
	};

	readonly #current = (): Event | undefined => this.#stack.at(-1);

	async #deliver(sink: Sink, event: WideEvent): Promise<void> {
		try {
			await sink.send(event);
		} catch (err) {
			if (this.#dev) {
				console.warn(`[observe] sink "${sink.name}" failed`, err);
			}
		}
	}

	readonly #emit: Emit = (event): void => {
		const decision = getSampleDecision(event, this.#sampleRate, this.#sampleExemptTiers);
		if (!decision.shouldKeep) {
			return;
		}

		event.sample_rate = decision.sampleRate;
		event.sampled = true;

		const scrubbed = redactEvent(event);
		for (const sink of this.#sinks) {
			const delivery = this.#deliver(sink, scrubbed);
			this.#pending.add(delivery);
			void delivery.finally(() => this.#pending.delete(delivery));
		}
	};

	async #run<T>(meta: BeginMeta, fn: (event: Event) => Promise<T> | T): Promise<T> {
		const span = this.begin(meta);
		this.#stack.push(span);
		try {
			return await fn(span);
		} catch (err) {
			span.error(err);
			throw err;
		} finally {
			span.end();
			const index = this.#stack.lastIndexOf(span);
			if (index !== -1) {
				this.#stack.splice(index, 1);
			}
		}
	}
}

export function createObservabilityClient(config: ClientConfig): ObservabilityClient {
	return new ObservabilityClient(config);
}
