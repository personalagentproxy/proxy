import {describe, expect, test} from 'bun:test';

import {
	AGENT_PROVIDERS,
	BUILT_IN_AGENT_PROVIDER,
	findAgentProvider,
	loginProviderIdFor,
	suggestAgentProvider,
} from './agent-providers';

describe('agent providers', () => {
	test('have unique ids', () => {
		expect(new Set(AGENT_PROVIDERS.map((provider) => provider.id)).size).toBe(
			AGENT_PROVIDERS.length,
		);
	});

	test('shared login providers are direct, valid account logins', () => {
		for (const product of AGENT_PROVIDERS) {
			if (!product.loginProviderId) {
				continue;
			}

			const loginProvider = findAgentProvider(product.loginProviderId);
			expect(loginProvider).toBeDefined();
			expect(loginProvider?.id).not.toBe(product.id);
			expect(loginProvider?.custom).not.toBe(true);
			expect(loginProvider?.loginProviderId).toBeUndefined();
		}
	});

	test('each has its favicon bundled with the web app', async () => {
		for (const provider of AGENT_PROVIDERS.filter((candidate) => !candidate.custom)) {
			expect(
				await Bun.file(new URL(`../../web/public${provider.faviconUrl}`, import.meta.url)).exists(),
			).toBe(true);
		}
	});

	test('each uses the logo shown in the README', async () => {
		for (const provider of AGENT_PROVIDERS.filter((candidate) => !candidate.custom)) {
			const productLogo = await Bun.file(
				new URL(`../../web/public${provider.faviconUrl}`, import.meta.url),
			).bytes();
			const readmeLogo = await Bun.file(
				new URL(`../../../docs/assets/agents/${provider.id}.png`, import.meta.url),
			).bytes();

			expect(productLogo).toEqual(readmeLogo);
		}
	});

	test('finds the built-in agent by id, which is not on offer', () => {
		expect(findAgentProvider('proxy')).toBe(BUILT_IN_AGENT_PROVIDER);
		expect(AGENT_PROVIDERS).not.toContain(BUILT_IN_AGENT_PROVIDER);
	});

	test('uses the same Claude Duet logo in the app, on the website and in the README', async () => {
		const appLogo = await Bun.file(
			new URL('../../web/public/agent-providers/claude-duet.png', import.meta.url),
		).bytes();
		const websiteLogo = await Bun.file(
			new URL('../../website/public/logos/claude-duet.png', import.meta.url),
		).bytes();
		const readmeLogo = await Bun.file(
			new URL('../../../docs/assets/agents/claude-duet.png', import.meta.url),
		).bytes();

		expect(appLogo).toEqual(readmeLogo);
		expect(websiteLogo).toEqual(readmeLogo);
	});

	test('finds a provider by id', () => {
		expect(findAgentProvider('dot')?.name).toBe('Dots');
		const duet = findAgentProvider('claude-duet');
		expect(duet?.name).toBe('Claude Duet');
		expect(duet && loginProviderIdFor(duet)).toBe('claude');
		expect(findAgentProvider('other')).toBeUndefined();
	});

	test('the built-in agent uses the app’s own icon', async () => {
		expect(
			await Bun.file(
				new URL(`../../web/public${BUILT_IN_AGENT_PROVIDER.faviconUrl}`, import.meta.url),
			).exists(),
		).toBe(true);
	});

	test("suggests the provider an MCP client's name points at", () => {
		expect(suggestAgentProvider('Claude')?.id).toBe('claude');
		expect(suggestAgentProvider('Claude Duet')?.id).toBe('claude');
		expect(suggestAgentProvider('Claude Code')?.id).toBe('claude-code');
		expect(suggestAgentProvider('Claude Desktop')?.id).toBe('claude-desktop');
		expect(suggestAgentProvider('Hermes Agent')?.id).toBe('hermes');
		expect(suggestAgentProvider('ChatGPT Connector')?.id).toBe('chatgpt');
		expect(suggestAgentProvider('Dot')?.id).toBe('dot');
		expect(suggestAgentProvider('Poke MCP client')?.id).toBe('poke');
		expect(suggestAgentProvider('MCP Inspector')).toBeUndefined();
		expect(suggestAgentProvider('Custom MCP agent')).toBeUndefined();
	});
});
