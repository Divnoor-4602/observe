import { z } from 'zod';

import { isPlainObject } from './wide-event.ts';

const KEY_PATTERN = /^[a-z][a-z0-9_]*$/;

function hasValidKeys(value: Record<string, unknown>): boolean {
	for (const [key, nested] of Object.entries(value)) {
		if (!KEY_PATTERN.test(key)) {
			return false;
		}

		if (isPlainObject(nested) && !hasValidKeys(nested)) {
			return false;
		}
	}

	return true;
}

export const wideEventSchema = z
	.object({
		auth_status: z.enum(['authenticated', 'anonymous']).optional(),
		deployment: z.string().optional(),
		duration_ms: z.number(),
		environment: z.enum(['production', 'staging', 'development']),
		error: z
			.object({
				code: z.string().optional(),
				message: z.string().optional(),
				type: z.string(),
			})
			.optional(),
		event: z.string(),
		event_id: z.string(),
		experiment_key: z.string().optional(),
		experiment_variant: z.string().optional(),
		function_type: z.string().optional(),
		method: z.string().optional(),
		outcome: z.enum(['success', 'error', 'cancelled']),
		parent_span_id: z.string().optional(),
		region: z.string().optional(),
		request_id: z.string().optional(),
		route: z.string().optional(),
		runtime: z.enum(['web', 'react_native', 'convex', 'python']),
		sample_rate: z.number().optional(),
		sampled: z.boolean().optional(),
		schema_version: z.literal(1),
		sentry_event_id: z.string().optional(),
		service: z.string().optional(),
		service_version: z.string().optional(),
		session_id: z.string().optional(),
		span_id: z.string(),
		status_code: z.number().optional(),
		trace_id: z.string(),
		ts: z.string(),
		user_id_hash: z.string().optional(),
		user_tier: z.string().optional(),
	})
	.catchall(z.unknown())
	.refine(hasValidKeys, 'wide event keys must be lowercase snake_case');

export type WideEvent = z.infer<typeof wideEventSchema>;
