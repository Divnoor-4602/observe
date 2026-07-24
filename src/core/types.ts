import type { WideEvent } from './schema.ts';

export type BeginMeta = Partial<WideEvent> & { event: string };

export type ClientConfig = {
	deployment?: string;
	environment?: 'development' | 'production' | 'staging';
	getContext?: () => Record<string, unknown>;
	randomBytes?: RandomBytes;
	region?: string;
	runtime: 'react_native' | 'web';
	sampleExemptTiers?: string[];
	sampleRate?: number;
	service?: string;
	serviceVersion?: string;
	sinks: Sink[];
};

export type RandomBytes = (bytes: Uint8Array) => void;

export type Sink = {
	flush?: () => Promise<void> | void;
	name: string;
	send: (event: WideEvent) => Promise<void> | void;
};
