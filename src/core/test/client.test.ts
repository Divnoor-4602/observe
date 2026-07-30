import { describe, expect, it } from 'vitest';

import { createMemorySink } from '../../sinks/dev.ts';
import { createObservabilityClient } from '../client.ts';
import { parseTraceArg, toTraceArg } from '../propagation.ts';
import { wideEventSchema } from '../schema.ts';

function makeClient() {
	const memory = createMemorySink();
	const client = createObservabilityClient({
		environment: 'development',
		runtime: 'web',
		sampleRate: 1,
		sinks: [memory],
	});
	return { client, memory };
}

describe('begin stamps ids', () => {
	it('mints trace_id, span_id and event_id on a root event', () => {
		const { client, memory } = makeClient();

		client.begin({ event: 'root' }).end();

		const event = memory.events[0];
		expect(event.event).toBe('root');
		expect(event.trace_id).toMatch(/^[0-9a-f]{32}$/);
		expect(event.span_id).toMatch(/^[0-9a-f]{16}$/);
		expect(event.event_id).toMatch(/^evt_[0-9a-f]{16}$/);
		expect(event.parent_span_id).toBeUndefined();
	});

	it('uses the injected randomBytes source', () => {
		const memory = createMemorySink();
		const client = createObservabilityClient({
			environment: 'development',
			randomBytes: (bytes) => bytes.fill(0xab),
			runtime: 'web',
			sampleRate: 1,
			sinks: [memory],
		});

		client.begin({ event: 'seeded' }).end();

		const event = memory.events[0];
		expect(event.trace_id).toBe('ab'.repeat(16));
		expect(event.span_id).toBe('ab'.repeat(8));
	});
});

describe('nested spans link into one trace', () => {
	it('shares trace_id and links parent_span_id, with a fresh span_id per hop', async () => {
		const { client, memory } = makeClient();

		await client.withInteraction('parent', async () => {
			await client.withInteraction('child', () => undefined);
		});

		const parent = memory.events.find((event) => event.event === 'parent');
		const child = memory.events.find((event) => event.event === 'child');

		expect(child?.trace_id).toBe(parent?.trace_id);
		expect(child?.parent_span_id).toBe(parent?.span_id);
		expect(child?.span_id).not.toBe(parent?.span_id);
		expect(parent?.parent_span_id).toBeUndefined();
	});
});

describe('inbound trace context', () => {
	it('inherits trace_id and parent_span_id from meta but mints a fresh span_id', () => {
		const { client, memory } = makeClient();
		const traceId = 'a'.repeat(32);
		const parentSpanId = 'b'.repeat(16);

		client.begin({ event: 'ingress', parent_span_id: parentSpanId, trace_id: traceId }).end();

		const event = memory.events[0];
		expect(event.trace_id).toBe(traceId);
		expect(event.parent_span_id).toBe(parentSpanId);
		expect(event.span_id).toMatch(/^[0-9a-f]{16}$/);
		expect(event.span_id).not.toBe(parentSpanId);
	});
});

describe('error outcome', () => {
	it('keeps outcome=error when the span throws', async () => {
		const { client, memory } = makeClient();

		await expect(
			client.withSpan({ event: 'boom' }, () => {
				throw new Error('kaboom');
			}),
		).rejects.toThrow('kaboom');

		const event = memory.events[0];
		expect(event.outcome).toBe('error');
		expect(event.error?.type).toBe('Error');
	});
});

describe('deep-merge accumulation', () => {
	it('accumulates a namespace across multiple add calls', async () => {
		const { client, memory } = makeClient();

		await client.withSpan({ event: 'payment_attempt' }, (span) => {
			span.add({ payment: { method: 'card', provider: 'stripe' } });
			span.add({ payment: { status: 'succeeded' } });
		});

		expect(memory.events[0].payment).toEqual({
			method: 'card',
			provider: 'stripe',
			status: 'succeeded',
		});
	});

	it('deep-merges request context and begin metadata', () => {
		const memory = createMemorySink();
		const client = createObservabilityClient({
			environment: 'development',
			getContext: () => ({
				gen_ai: { provider: { name: 'openai' }, request: { temperature: 0.2 } },
			}),
			runtime: 'web',
			sampleRate: 1,
			sinks: [memory],
		});

		client.begin({ event: 'model_call', gen_ai: { request: { model: 'gpt-5.5' } } }).end();

		expect(memory.events[0].gen_ai).toEqual({
			provider: { name: 'openai' },
			request: { model: 'gpt-5.5', temperature: 0.2 },
		});
	});
});

describe('child sub-spans', () => {
	it('inherits trace_id, links parent_span_id and mints a fresh span_id', () => {
		const { client, memory } = makeClient();

		const parent = client.begin({ event: 'chat_turn' });
		parent.child('model_call').end();
		parent.end();

		const parentEvent = memory.events.find((event) => event.event === 'chat_turn');
		const childEvent = memory.events.find((event) => event.event === 'model_call');

		expect(childEvent?.trace_id).toBe(parentEvent?.trace_id);
		expect(childEvent?.parent_span_id).toBe(parentEvent?.span_id);
		expect(childEvent?.span_id).not.toBe(parentEvent?.span_id);
	});
});

describe('error completions', () => {
	it('captures error.code from the error object', async () => {
		const { client, memory } = makeClient();
		const err = Object.assign(new Error('declined'), { code: 'card_declined' });

		await expect(
			client.withSpan({ event: 'pay' }, () => {
				throw err;
			}),
		).rejects.toThrow('declined');

		expect(memory.events[0].error?.code).toBe('card_declined');
	});

	it('captures error.code from a structured data payload', async () => {
		const { client, memory } = makeClient();
		const err = Object.assign(new Error('forbidden'), { data: { code: 'FORBIDDEN' } });

		await expect(
			client.withSpan({ event: 'guarded' }, () => {
				throw err;
			}),
		).rejects.toThrow('forbidden');

		expect(memory.events[0].error?.code).toBe('FORBIDDEN');
	});

	it('merges extra fields passed to error()', () => {
		const { client, memory } = makeClient();

		const span = client.begin({ event: 'op' });
		span.error(new Error('boom'), { stage: 'model_call' });
		span.end();

		const event = memory.events[0];
		expect(event.outcome).toBe('error');
		expect(event.stage).toBe('model_call');
	});
});

describe('withSpan joins the ambient stack', () => {
	it('routes ambient add calls to the active span', async () => {
		const { client, memory } = makeClient();

		await client.withSpan({ event: 'chat_turn' }, () => {
			client.add({ model: 'gpt-5.5' });
		});

		expect(memory.events[0].model).toBe('gpt-5.5');
	});

	it('links a span opened inside an interaction into the same trace', async () => {
		const { client, memory } = makeClient();

		await client.withInteraction('chat_send', async () => {
			await client.withSpan({ event: 'client_chat_submit' }, () => undefined);
		});

		const parent = memory.events.find((event) => event.event === 'chat_send');
		const child = memory.events.find((event) => event.event === 'client_chat_submit');
		expect(child?.trace_id).toBe(parent?.trace_id);
		expect(child?.parent_span_id).toBe(parent?.span_id);
	});
});

describe('error state is sticky', () => {
	it('ignores outcome and error overrides passed via error fields', () => {
		const { client, memory } = makeClient();

		const span = client.begin({ event: 'op' });
		span.error(new Error('boom'), { outcome: 'success', stage: 'model_call' });
		span.end();

		const event = memory.events[0];
		expect(event.outcome).toBe('error');
		expect(event.error?.message).toBe('boom');
		expect(event.stage).toBe('model_call');
	});
});

describe('flush drains late deliveries', () => {
	it('waits for deliveries scheduled while flushing', async () => {
		const delivered: string[] = [];
		const client = createObservabilityClient({
			environment: 'development',
			randomBytes: (bytes) => bytes.fill(0),
			runtime: 'web',
			sinks: [
				{
					name: 'slow',
					send: async (event) => {
						await new Promise((resolve) => setTimeout(resolve, 5));
						delivered.push(event.event);
					},
				},
			],
		});

		client.begin({ event: 'first' }).end();
		const flushing = client.flush();
		client.begin({ event: 'second' }).end();
		await flushing;

		expect(delivered).toContain('first');
		expect(delivered).toContain('second');
	});

	it('settles every sink when a flush callback throws synchronously', async () => {
		let workingSinkFlushed = false;
		const client = createObservabilityClient({
			environment: 'development',
			runtime: 'web',
			sinks: [
				{
					flush: () => {
						throw new Error('flush down');
					},
					name: 'broken',
					send: () => undefined,
				},
				{
					flush: () => {
						workingSinkFlushed = true;
					},
					name: 'working',
					send: () => undefined,
				},
			],
		});

		await expect(client.flush()).resolves.toBeUndefined();
		expect(workingSinkFlushed).toBe(true);
	});
});

describe('sink isolation', () => {
	it('gives every sink its own redacted event clone', async () => {
		const memory = createMemorySink();
		const client = createObservabilityClient({
			environment: 'development',
			runtime: 'web',
			sampleRate: 1,
			sinks: [
				{
					name: 'mutating',
					send: (event) => {
						event.note = 'changed by first sink';
					},
				},
				memory,
			],
		});

		client.begin({ event: 'fan_out', note: 'original' }).end();
		await client.flush();

		expect(memory.events[0].note).toBe('original');
	});
});

describe('sampling at emit', () => {
	it('defaults to a 20% keep rate and stamps sampled + sample_rate', () => {
		const memory = createMemorySink();
		const client = createObservabilityClient({
			environment: 'development',
			randomBytes: (bytes) => bytes.fill(0x00),
			runtime: 'web',
			sinks: [memory],
		});

		client.begin({ event: 'root' }).end();

		const event = memory.events[0];
		expect(event.sampled).toBe(true);
		expect(event.sample_rate).toBe(0.2);
	});

	it('drops head-sampled-out events before any sink', () => {
		const memory = createMemorySink();
		const client = createObservabilityClient({
			environment: 'development',
			randomBytes: (bytes) => bytes.fill(0xff),
			runtime: 'web',
			sampleRate: 0.5,
			sinks: [memory],
		});

		client.begin({ event: 'dropped' }).end();

		expect(memory.events).toHaveLength(0);
	});

	it('keeps every hop of a kept trace and stamps the configured rate', async () => {
		const memory = createMemorySink();
		const client = createObservabilityClient({
			environment: 'development',
			randomBytes: (bytes) => bytes.fill(0x00),
			runtime: 'web',
			sampleRate: 0.5,
			sinks: [memory],
		});

		await client.withInteraction('parent', async () => {
			await client.withInteraction('child', () => undefined);
		});

		expect(memory.events).toHaveLength(2);
		for (const event of memory.events) {
			expect(event.sampled).toBe(true);
			expect(event.sample_rate).toBe(0.5);
		}
	});

	it('rescues errors past a zero rate with sample_rate 1', async () => {
		const memory = createMemorySink();
		const client = createObservabilityClient({
			environment: 'development',
			randomBytes: (bytes) => bytes.fill(0xff),
			runtime: 'web',
			sampleRate: 0,
			sinks: [memory],
		});

		await expect(
			client.withSpan({ event: 'boom' }, () => {
				throw new Error('kaboom');
			}),
		).rejects.toThrow('kaboom');

		expect(memory.events).toHaveLength(1);
		expect(memory.events[0].sample_rate).toBe(1);
	});

	it('always keeps configured user tiers past a zero rate', () => {
		const memory = createMemorySink();
		const client = createObservabilityClient({
			environment: 'development',
			randomBytes: (bytes) => bytes.fill(0xff),
			runtime: 'web',
			sampleExemptTiers: ['premium'],
			sampleRate: 0,
			sinks: [memory],
		});

		client.begin({ event: 'paid', user_tier: 'premium' }).end();
		client.begin({ event: 'free', user_tier: 'free' }).end();

		expect(memory.events).toHaveLength(1);
		expect(memory.events[0].event).toBe('paid');
		expect(memory.events[0].sample_rate).toBe(1);
	});
});

function makeDetachedClient() {
	const memory = createMemorySink();
	const client = createObservabilityClient({
		ambient: false,
		environment: 'development',
		runtime: 'convex',
		sampleRate: 1,
		sinks: [memory],
	});
	return { client, memory };
}

describe('ambient: false clients', () => {
	it('runs the span lifecycle without joining the ambient stack', async () => {
		const { client, memory } = makeDetachedClient();

		await client.withSpan({ event: 'outer' }, () => {
			client.add({ leaked: true });
			client.begin({ event: 'inner' }).end();
		});

		const outer = memory.events.find((event) => event.event === 'outer');
		const inner = memory.events.find((event) => event.event === 'inner');
		expect(outer?.leaked).toBeUndefined();
		expect(inner?.parent_span_id).toBeUndefined();
		expect(inner?.trace_id).not.toBe(outer?.trace_id);
	});

	it('still records errors and rethrows', async () => {
		const { client, memory } = makeDetachedClient();

		await expect(
			client.withSpan({ event: 'boom' }, () => {
				throw new Error('kaboom');
			}),
		).rejects.toThrow('kaboom');

		expect(memory.events[0].outcome).toBe('error');
	});
});

describe('currentTrace', () => {
	it('returns undefined outside any span', () => {
		const { client } = makeClient();

		expect(client.currentTrace()).toBeUndefined();
	});

	it('returns the active span ids inside an interaction', async () => {
		const { client, memory } = makeClient();

		await client.withInteraction('chat_send', () => {
			const trace = client.currentTrace();
			expect(trace?.traceId).toMatch(/^[0-9a-f]{32}$/);
			expect(trace?.spanId).toMatch(/^[0-9a-f]{16}$/);
		});

		const event = memory.events[0];
		await client.withInteraction('outer', () => {
			expect(client.currentTrace()?.traceId).not.toBe(event.trace_id);
		});
	});

	it('reports the head sampling decision for the configured rate', async () => {
		const memory = createMemorySink();
		const client = createObservabilityClient({
			environment: 'development',
			randomBytes: (bytes) => bytes.fill(0xff),
			runtime: 'web',
			sampleRate: 0.5,
			sinks: [memory],
		});

		await client.withInteraction('dropped', () => {
			expect(client.currentTrace()?.sampled).toBe(false);
		});
	});

	it('stitches a second client into the same trace via the args codec', async () => {
		const { client: appClient, memory: appMemory } = makeClient();
		const { client: serverClient, memory: serverMemory } = makeClient();

		await appClient.withInteraction('chat_send', () => {
			const trace = appClient.currentTrace();
			const arg = trace === undefined ? undefined : toTraceArg(trace);
			serverClient.begin({ event: 'send_message', ...parseTraceArg(arg) }).end();
		});

		const clientEvent = appMemory.events.find((event) => event.event === 'chat_send');
		const serverEvent = serverMemory.events.find((event) => event.event === 'send_message');

		expect(serverEvent?.trace_id).toBe(clientEvent?.trace_id);
		expect(serverEvent?.parent_span_id).toBe(clientEvent?.span_id);
		expect(serverEvent?.span_id).not.toBe(clientEvent?.span_id);
	});
});

describe('traceArg', () => {
	it('hands out wire context with the span as parent, round-tripping the parser', () => {
		const { client, memory } = makeClient();

		const span = client.begin({ event: 'parent_hop' });
		const arg = span.traceArg();
		span.end();

		expect(parseTraceArg(arg)).toEqual(arg);
		expect(arg.trace_id).toBe(memory.events[0].trace_id);
		expect(arg.parent_span_id).toBe(memory.events[0].span_id);
	});

	it('is total for spans begun from inbound context', () => {
		const { client } = makeClient();
		const traceId = 'a'.repeat(32);

		const span = client.begin({ event: 'ingress', trace_id: traceId });
		const arg = span.traceArg();
		span.end();

		expect(arg.trace_id).toBe(traceId);
		expect(arg.parent_span_id).toMatch(/^[0-9a-f]{16}$/);
	});
});

describe('emitted events satisfy the envelope schema', () => {
	it('stamps schema_version, ts, environment and runtime', () => {
		const { client, memory } = makeClient();

		client.begin({ event: 'root' }).end();

		const event = memory.events[0];
		expect(event.schema_version).toBe(1);
		expect(event.runtime).toBe('web');
		expect(event.environment).toBe('development');
		expect(event.ts).toMatch(/^\d{4}-\d{2}-\d{2}T/);
	});

	it('produces schema-valid wide events', async () => {
		const { client, memory } = makeClient();

		await client.withSpan({ event: 'chat_turn' }, (span) => {
			span.add({ model: 'gpt-5.5' });
		});

		expect(wideEventSchema.safeParse(memory.events[0]).success).toBe(true);
	});

	it('normalizes values before emit', () => {
		const { client, memory } = makeClient();

		const span = client.begin({ event: 'op' });
		span.add({ at: new Date('2026-07-13T00:00:00.000Z'), big: 5n, list: [1, 2] });
		span.end();

		const event = memory.events[0];
		expect(event.at).toBe('2026-07-13T00:00:00.000Z');
		expect(event.big).toBe('5');
		expect('list' in event).toBe(false);
		expect(wideEventSchema.safeParse(event).success).toBe(true);
	});
});
