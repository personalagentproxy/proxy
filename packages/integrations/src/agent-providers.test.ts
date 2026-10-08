import {describe, expect, test} from 'bun:test';

import {AGENT_PROVIDERS, findAgentProvider, suggestAgentProvider} from './agent-providers';

describe('agent providers', () => {
	test('have unique ids', () => {
		expect(new Set(AGENT_PROVIDERS.map((provider) => provider.id)).size).toBe(
			AGENT_PROVIDERS.length,
		);
	});

	test('each has its favicon bundled with the web app', async () => {
		for (const provider of AGENT_PROVIDERS) {
			expect(
				await Bun.file(new URL(`../../web/public${provider.faviconUrl}`, import.meta.url)).exists(),
			).toBe(true);
		}
	});

	test('finds a provider by id', () => {
		expect(findAgentProvider('dot')?.name).toBe('Dots');
		expect(findAgentProvider('other')).toBeUndefined();
	});

	test("suggests the provider an MCP client's name points at", () => {
		expect(suggestAgentProvider('Claude')?.id).toBe('claude');
		expect(suggestAgentProvider('ChatGPT Connector')?.id).toBe('chatgpt');
		expect(suggestAgentProvider('Dot')?.id).toBe('dot');
		expect(suggestAgentProvider('Poke MCP client')?.id).toBe('poke');
		expect(suggestAgentProvider('MCP Inspector')).toBeUndefined();
	});
});
