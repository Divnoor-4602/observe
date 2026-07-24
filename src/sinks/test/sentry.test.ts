import { describe, expect, it } from 'vitest';

import type { WideEvent } from '../../core/schema.ts';
import type { SentryBreadcrumb } from '../sentry.ts';

import { createSentrySink } from '../sentry.ts';

function makeEvent(overrides: Partial<WideEvent> = {}): WideEvent {
	return {
		duration_ms: 42,
		environment: 'production',
		event: 'chat_turn',
		event_id: 'evt_0000000000000001',
		outcome: 'success',
		runtime: 'web',
		schema_version: 1,
		span_id: '0'.repeat(15) + '1',
		trace_id: '0'.repeat(31) + '1',
		ts: '2026-07-23T00:00:00.000Z',
		...overrides,
	};
}

function makeFakes() {
	const breadcrumbs: SentryBreadcrumb[] = [];
	const contexts: Record<string, null | Record<string, unknown>> = {};
	const tags: Record<string, string> = {};

	return {
		breadcrumbs,
		contexts,
		fns: {
			addBreadcrumb: (breadcrumb: SentryBreadcrumb) => {
				breadcrumbs.push(breadcrumb);
			},
			setContext: (name: string, context: null | Record<string, unknown>) => {
				contexts[name] = context;
			},
			setTag: (key: string, value: string) => {
				tags[key] = value;
			},
		},
		tags,
	};
}

describe('createSentrySink', () => {
	it('adds a breadcrumb and refreshes the trace tag for every event', () => {
		const { breadcrumbs, fns, tags } = makeFakes();
		const sink = createSentrySink(fns);

		void sink.send(makeEvent());

		expect(breadcrumbs).toHaveLength(1);
		expect(breadcrumbs[0].category).toBe('observe');
		expect(breadcrumbs[0].level).toBe('info');
		expect(breadcrumbs[0].message).toBe('chat_turn success 42ms');
		expect(tags.trace_id).toBe('0'.repeat(31) + '1');
	});

	it('does not set error tags or context on success events', () => {
		const { contexts, fns, tags } = makeFakes();

		void createSentrySink(fns).send(makeEvent());

		expect(tags.observe_event).toBeUndefined();
		expect(tags.route).toBeUndefined();
		expect(contexts.observe).toBeUndefined();
	});

	it('tags and contextualizes error events', () => {
		const { breadcrumbs, contexts, fns, tags } = makeFakes();

		void createSentrySink(fns).send(
			makeEvent({
				error: { code: 'provider_timeout', message: 'timeout', type: 'Error' },
				outcome: 'error',
				route: 'chat.stream',
			}),
		);

		expect(breadcrumbs[0].level).toBe('error');
		expect(tags.observe_event).toBe('chat_turn');
		expect(tags.route).toBe('chat.stream');
		expect(contexts.observe).toEqual({
			duration_ms: 42,
			error_code: 'provider_timeout',
			event: 'chat_turn',
			span_id: '0'.repeat(15) + '1',
		});
	});

	it('uses a warning breadcrumb for cancelled events', () => {
		const { breadcrumbs, fns } = makeFakes();

		void createSentrySink(fns).send(makeEvent({ outcome: 'cancelled' }));

		expect(breadcrumbs[0].level).toBe('warning');
	});

	it('swallows throwing vendor functions', () => {
		const sink = createSentrySink({
			addBreadcrumb: () => {
				throw new Error('sentry down');
			},
			setContext: () => {
				throw new Error('sentry down');
			},
			setTag: () => {
				throw new Error('sentry down');
			},
		});

		expect(() => sink.send(makeEvent({ outcome: 'error' }))).not.toThrow();
	});

	it('passes flush through and swallows its failures', async () => {
		let flushed = false;
		const sink = createSentrySink({
			...makeFakes().fns,
			flush: () => {
				flushed = true;
				throw new Error('flush failed');
			},
		});

		await expect(Promise.resolve(sink.flush?.())).resolves.toBeUndefined();
		expect(flushed).toBe(true);
	});

	it('omits flush when not injected', () => {
		const sink = createSentrySink(makeFakes().fns);
		expect(sink.flush).toBeUndefined();
	});
});
