import type { Catalog, InferEvents } from './registry.ts';

import { chatEvents } from './chat.ts';
import { paymentEvents } from './payments.ts';

export { catalogSchema } from './registry.ts';
export type { Catalog, InferEvents } from './registry.ts';

const events = { ...chatEvents, ...paymentEvents };

export const catalog: Catalog = events;

export type CatalogEvents = InferEvents<typeof events>;
