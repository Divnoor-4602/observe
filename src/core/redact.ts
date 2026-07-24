import type { WideEvent } from './schema.ts';

import { isPlainObject } from './wide-event.ts';

const DENIED_KEYS = new Set([
	'api_key',
	'authorization',
	'card_number',
	'credit_card',
	'cvv',
	'password',
	'secret',
	'ssn',
]);

type Scanner = {
	pattern: RegExp;
	type: string;
	validate?: (match: string) => boolean;
};

const SCANNERS: Scanner[] = [
	{ pattern: /\beyJ[\w-]+\.[\w-]+\.[\w-]+/g, type: 'jwt' },
	{ pattern: /\b(?:sk|pk)_\w{8,}/g, type: 'api_key' },
	{ pattern: /\bAKIA[0-9A-Z]{16}\b/g, type: 'api_key' },
	{ pattern: /\b[\w.%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, type: 'email' },
	{ pattern: /\b\d(?:[ -]?\d){12,18}\b/g, type: 'credit_card', validate: isLuhnValid },
	{ pattern: /\b(?:\d{1,3}\.){3}\d{1,3}\b/g, type: 'ipv4' },
	{ pattern: /\+\d(?:[ ().-]?\d){7,14}\b/g, type: 'phone' },
];

export function redactEvent(event: WideEvent): WideEvent {
	const output: WideEvent = { ...event };
	const bag: Record<string, unknown> = output;

	for (const key of Object.keys(bag)) {
		if (isDeniedKey(key)) {
			delete bag[key];
			continue;
		}

		bag[key] = redactValue(bag[key]);
	}

	return output;
}

function isDeniedKey(key: string): boolean {
	return DENIED_KEYS.has(key) || key.endsWith('_token');
}

function isLuhnValid(candidate: string): boolean {
	const digits = candidate.replaceAll(/\D/g, '');
	if (digits.length < 13 || digits.length > 19) {
		return false;
	}

	let sum = 0;
	let shouldDouble = false;
	for (let index = digits.length - 1; index >= 0; index -= 1) {
		let digit = digits.charCodeAt(index) - 48;
		if (shouldDouble) {
			digit *= 2;
			if (digit > 9) {
				digit -= 9;
			}
		}
		sum += digit;
		shouldDouble = !shouldDouble;
	}

	return sum % 10 === 0;
}

function redactObject(source: Record<string, unknown>): Record<string, unknown> {
	const output: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(source)) {
		if (isDeniedKey(key)) {
			continue;
		}

		output[key] = redactValue(value);
	}

	return output;
}

function redactValue(value: unknown): unknown {
	if (typeof value === 'string') {
		return scrubString(value);
	}

	if (isPlainObject(value)) {
		return redactObject(value);
	}

	return value;
}

function scrubString(value: string): string {
	let result = value;
	for (const scanner of SCANNERS) {
		result = result.replace(scanner.pattern, (match) =>
			scanner.validate === undefined || scanner.validate(match)
				? `[REDACTED:${scanner.type}]`
				: match,
		);
	}

	return result;
}
