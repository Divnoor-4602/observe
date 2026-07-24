import type { RandomBytes } from './types.ts';

const TRACE_ID_BYTES = 16;
const SPAN_ID_BYTES = 8;
const READABLE_ID_BYTES = 8;

const BYTE_TO_HEX = Array.from({ length: 256 }, (_, value) => value.toString(16).padStart(2, '0'));

export const defaultRandomBytes: RandomBytes = (bytes) => {
	const cryptoApi: Crypto | undefined = globalThis.crypto;

	// oxlint-disable-next-line typescript/no-unnecessary-condition -- React Native may omit Web Crypto at runtime.
	if (typeof cryptoApi?.getRandomValues === 'function') {
		bytes.set(cryptoApi.getRandomValues(new Uint8Array(bytes.length)));
		return;
	}

	for (let index = 0; index < bytes.length; index += 1) {
		bytes[index] = Math.floor(Math.random() * 256);
	}
};

export function newEventId(rng: RandomBytes = defaultRandomBytes): string {
	return `evt_${randomHex(READABLE_ID_BYTES, rng)}`;
}

export function newRequestId(rng: RandomBytes = defaultRandomBytes): string {
	return `req_${randomHex(READABLE_ID_BYTES, rng)}`;
}

export function newSpanId(rng: RandomBytes = defaultRandomBytes): string {
	return randomHex(SPAN_ID_BYTES, rng);
}

export function newTraceId(rng: RandomBytes = defaultRandomBytes): string {
	return randomHex(TRACE_ID_BYTES, rng);
}

function randomHex(byteCount: number, rng: RandomBytes): string {
	const bytes = new Uint8Array(new ArrayBuffer(byteCount));
	rng(bytes);

	if (bytes.every((byte) => byte === 0)) {
		bytes[bytes.length - 1] = 1;
	}

	let value = '';
	for (const byte of bytes) {
		value += BYTE_TO_HEX[byte];
	}
	return value;
}
