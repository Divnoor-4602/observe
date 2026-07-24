import type { Event } from './core/accumulator.ts';
import type { ObservabilityClient } from './core/client.ts';
import type { WideEvent } from './core/schema.ts';
import type { BeginMeta } from './core/types.ts';

let installedClient: ObservabilityClient | undefined;

function requireClient(): ObservabilityClient {
	if (installedClient === undefined) {
		throw new Error('[observe] no client installed — call installObservability(client) at startup');
	}

	return installedClient;
}

export const obs = {
	add(fields: Partial<WideEvent>): void {
		installedClient?.add(fields);
	},
	begin(meta: BeginMeta): Event {
		return requireClient().begin(meta);
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

export {
	defaultRandomBytes,
	newEventId,
	newRequestId,
	newSpanId,
	newTraceId,
} from './core/identifier.ts';
export { formatTraceparent, parseTraceparent } from './core/propagation.ts';
