import {describe, expect, test} from 'bun:test';
import {INTEGRATIONS} from '@/lib/integrations';

describe('integration logos', () => {
	test('serves bundled logos for external integrations only', async () => {
		const external = INTEGRATIONS.filter((integration) => !integration.builtIn);
		const information = INTEGRATIONS.find((integration) => integration.builtIn);

		expect(information?.logoUrl).toBeUndefined();
		for (const integration of external) {
			expect(integration.logoUrl).toBeDefined();
			if (!integration.logoUrl) {
				continue;
			}

			expect(integration.logoUrl).toStartWith('/integrations/');
			const assetUrl = new URL(`../../public${integration.logoUrl}`, import.meta.url);
			expect(await Bun.file(assetUrl).exists()).toBe(true);
		}
	});
});
