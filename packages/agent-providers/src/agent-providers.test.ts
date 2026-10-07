import {describe, expect, test} from 'bun:test';

import {AGENT_PROVIDER_IDS, AGENT_PROVIDERS, findAgentProvider} from './agent-providers';

describe('agent provider catalog', () => {
	test('has one unique entry for every supported provider id', () => {
		expect(AGENT_PROVIDERS.map((provider) => provider.id)).toEqual([...AGENT_PROVIDER_IDS]);
		expect(new Set(AGENT_PROVIDER_IDS).size).toBe(AGENT_PROVIDER_IDS.length);
	});

	test('finds known providers and serves every bundled favicon', async () => {
		for (const provider of AGENT_PROVIDERS) {
			expect(findAgentProvider(provider.id)).toBe(provider);
			expect(provider.faviconUrl).toStartWith('/agent-providers/');
			const assetUrl = new URL(`../../web/public${provider.faviconUrl}`, import.meta.url);
			expect(await Bun.file(assetUrl).exists()).toBe(true);
		}
		expect(findAgentProvider('other')).toBeUndefined();
	});
});
