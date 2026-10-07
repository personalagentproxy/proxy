import {describe, expect, test} from 'bun:test';
import {INTEGRATIONS} from '@/lib/integrations';

describe('integration logos', () => {
	test('serves one bundled logo for every integration', async () => {
		for (const integration of INTEGRATIONS) {
			expect(integration.logoUrl).toStartWith('/integrations/');
			const assetUrl = new URL(`../../public${integration.logoUrl}`, import.meta.url);
			expect(await Bun.file(assetUrl).exists()).toBe(true);
		}
	});
});
