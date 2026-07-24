import { isPlainObject } from './wide-event.ts';

const MAX_STRING = 1024;
const MAX_FIELDS = 256;
const MAX_DEPTH = 6;

const FORBIDDEN_PREFIXES = ['gen_ai.input', 'gen_ai.output', 'gen_ai.system_instructions'];

export function normalize(bag: Record<string, unknown>): void {
	normalizeObject(bag, '', 0, { count: 0 });
}

function isForbiddenPath(path: string): boolean {
	return FORBIDDEN_PREFIXES.some((prefix) => path === prefix || path.startsWith(`${prefix}.`));
}

function normalizeLeaf(value: unknown): unknown {
	if (typeof value === 'string') {
		return value.length > MAX_STRING ? `${value.slice(0, MAX_STRING)}…` : value;
	}

	if (typeof value === 'number') {
		return Number.isFinite(value) ? value : null;
	}

	if (typeof value === 'boolean' || value === null) {
		return value;
	}

	if (typeof value === 'bigint') {
		return String(value);
	}

	if (value instanceof Date) {
		return value.toISOString();
	}

	return undefined;
}

function normalizeObject(
	bag: Record<string, unknown>,
	path: string,
	depth: number,
	counter: { count: number },
): void {
	for (const key of Object.keys(bag)) {
		const fieldPath = path === '' ? key : `${path}.${key}`;
		const value = bag[key];

		if (value === undefined || isForbiddenPath(fieldPath) || counter.count >= MAX_FIELDS) {
			delete bag[key];
			continue;
		}

		if (isPlainObject(value)) {
			if (depth >= MAX_DEPTH) {
				delete bag[key];
			} else {
				normalizeObject(value, fieldPath, depth + 1, counter);
			}
			continue;
		}

		const leaf = normalizeLeaf(value);
		if (leaf === undefined) {
			delete bag[key];
			continue;
		}

		bag[key] = leaf;
		counter.count += 1;
	}
}
