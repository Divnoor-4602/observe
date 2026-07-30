import type { Sink } from '../core/types.ts';

export function createLogStreamSink(name = 'log-stream'): Sink {
	return {
		name,
		send: (event) => {
			console.info(JSON.stringify({ event, type: 'observability_event' }));
		},
	};
}
