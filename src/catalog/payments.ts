import { z } from 'zod';

export const paymentEvents = {
	payment_attempt: z.object({
		event: z.literal('payment_attempt'),
		payment: z.object({
			amount_minor: z.number(),
			currency: z.string(),
			processor: z.string(),
			status: z.string(),
		}),
	}),
};
