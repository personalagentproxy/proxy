import {describe, expect, test} from 'bun:test';

import {
	AGENT_PROVIDERS,
	BUILT_IN_AGENT_PROVIDER,
	findAgentProvider,
	suggestAgentProvider,
} from './agent-providers';

describe('agent providers', () => {
	test('have unique ids', () => {
		expect(new Set(AGENT_PROVIDERS.map((provider) => provider.id)).size).toBe(
			AGENT_PROVIDERS.length,
		);
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

	test('finds a provider by id, the built-in agent too, which is not on offer', () => {
		expect(findAgentProvider('dot')?.name).toBe('Dots');
		expect(findAgentProvider('proxy')).toBe(BUILT_IN_AGENT_PROVIDER);
		expect(AGENT_PROVIDERS).not.toContain(BUILT_IN_AGENT_PROVIDER);
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
