export function deepMerge(target: Record<string, unknown>, source: Record<string, unknown>): void {
	for (const key of Object.keys(source)) {
		if (key === '__proto__' || key === 'constructor') {
			continue;
		}

		const sourceValue = source[key];
		if (isPlainObject(sourceValue)) {
			const existing = target[key];
			const nested = isPlainObject(existing) ? existing : {};
			deepMerge(nested, sourceValue);
			target[key] = nested;
		} else {
			target[key] = sourceValue;
		}
	}
}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
	if (typeof value !== 'object' || value === null) {
		return false;
	}

	const prototype: unknown = Object.getPrototypeOf(value);
	return prototype === null || prototype === Object.prototype;
}

export function readString(value: unknown): string | undefined {
	return typeof value === 'string' ? value : undefined;
}
