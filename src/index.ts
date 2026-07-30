import type { Event } from './core/accumulator.ts';
import type { TraceContext } from './core/propagation.ts';
import type { WideEvent } from './core/schema.ts';
import type { BeginMeta } from './core/types.ts';

import { createObservabilityClient, type ObservabilityClient } from './core/client.ts';

let installedClient: ObservabilityClient | undefined;
let fallbackClient: ObservabilityClient | undefined;

function requireClient(): ObservabilityClient {
	if (installedClient !== undefined) {
		return installedClient;
	}

	if (fallbackClient === undefined) {
		fallbackClient = createObservabilityClient({ runtime: 'web', sinks: [] });
		console.warn(
			'[observe] no client installed — events are dropped until installObservability(client) runs',
		);
	}

	return fallbackClient;
}

export const obs = {
	add(fields: Partial<WideEvent>): void {
		installedClient?.add(fields);
	},
	begin(meta: BeginMeta): Event {
		return requireClient().begin(meta);
	},
	currentTrace(): TraceContext | undefined {
		return installedClient?.currentTrace();
	},
	error(err: unknown): void {
		installedClient?.error(err);
	},
	withInteraction<T>(name: string, fn: () => Promise<T> | T): Promise<T> {
		return requireClient().withInteraction(name, fn);
	},
	withSpan<T>(meta: BeginMeta, fn: (event: Event) => Promise<T> | T): Promise<T> {
		return requireClient().withSpan(meta, fn);
	},
};

export function installObservability(client: ObservabilityClient): void {
	installedClient = client;
}

export type { Event } from './core/accumulator.ts';
export {
	defaultRandomBytes,
	newEventId,
	newRequestId,
	newSpanId,
	newTraceId,
} from './core/identifier.ts';
export {
	formatTraceparent,
	fromRequest,
	parseTraceArg,
	parseTraceparent,
	toTraceArg,
	type TraceArg,
	type TraceContext,
} from './core/propagation.ts';
