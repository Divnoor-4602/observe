import type { z, ZodType } from 'zod';

export type Catalog = Record<string, ZodType>;

export type InferEvents<T extends Catalog> = {
	[K in keyof T]: z.infer<T[K]>;
};

export function catalogSchema(catalog: Catalog, event: string): undefined | ZodType {
	return Object.hasOwn(catalog, event) ? catalog[event] : undefined;
}
