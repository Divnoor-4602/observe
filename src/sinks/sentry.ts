import type { WideEvent } from '../core/schema.ts';
import type { Sink } from '../core/types.ts';

export type SentryBreadcrumb = {
	category: string;
	data?: Record<string, unknown>;
	level: 'error' | 'info' | 'warning';
	message: string;
};

export type SentrySinkConfig = {
	addBreadcrumb: (breadcrumb: SentryBreadcrumb) => void;
	flush?: () => Promise<void> | void;
	setContext: (name: string, context: null | Record<string, unknown>) => void;
	setTag: (key: string, value: string) => void;
};

const BREADCRUMB_LEVELS: Record<WideEvent['outcome'], SentryBreadcrumb['level']> = {
	cancelled: 'warning',
	error: 'error',
	success: 'info',
};

export function createSentrySink(config: SentrySinkConfig): Sink {
	const flush = config.flush;

	return {
		flush:
			flush === undefined
				? undefined
				: async () => {
						try {
							await flush();
						} catch {
							// A broken Sentry integration must never affect emit.
						}
					},
		name: 'sentry',
		send: (event) => {
			guard(() => {
				config.addBreadcrumb({
					category: 'observe',
					data: {
						route: event.route,
						span_id: event.span_id,
						trace_id: event.trace_id,
					},
					level: BREADCRUMB_LEVELS[event.outcome],
					message: `${event.event} ${event.outcome} ${event.duration_ms}ms`,
				});
			});

			guard(() => {
				config.setTag('trace_id', event.trace_id);
			});

			if (event.outcome !== 'error') {
				return;
			}

			guard(() => {
				config.setTag('observe_event', event.event);
			});
			if (event.route !== undefined) {
				guard(() => {
					config.setTag('route', event.route ?? '');
				});
			}
			guard(() => {
				config.setContext('observe', {
					duration_ms: event.duration_ms,
					error_code: event.error?.code,
					event: event.event,
					span_id: event.span_id,
				});
			});
		},
	};
}

function guard(fn: () => void): void {
	try {
		fn();
	} catch {
		// A broken Sentry integration must never affect emit.
	}
}
