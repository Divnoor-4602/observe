import { afterEach, describe, expect, it, vi } from 'vitest';

describe('uninstalled global API', () => {
	afterEach(() => {
		vi.resetModules();
		vi.restoreAllMocks();
	});

	it('drops spans through a lazy no-op client instead of throwing', async () => {
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
		const { obs } = await import('../../index.ts');

		expect(() => obs.begin({ event: 'before_install' }).end()).not.toThrow();
		expect(obs.currentTrace()).toBeUndefined();
		expect(warn).toHaveBeenCalledTimes(1);
	});
});
