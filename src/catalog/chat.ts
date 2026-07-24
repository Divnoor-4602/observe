import { z } from 'zod';

export const chatEvents = {
	chat_turn: z.object({
		conversation_id: z.string().optional(),
		event: z.literal('chat_turn'),
		gen_ai: z.object({
			provider: z.object({ name: z.string() }),
			request: z.object({ model: z.string() }),
			usage: z.object({ input_tokens: z.number(), output_tokens: z.number() }).optional(),
		}),
	}),
};
