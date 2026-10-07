import {describe, expect, test} from 'bun:test';
import {AGENT_PROVIDERS, agentProvider, type AgentProviderId} from '@/lib/agent-providers';
import {addAgent} from '@/lib/agents';
import type {AgentLogin} from '@/lib/types';

function login(providerId: AgentProviderId, id: string = providerId): AgentLogin {
	return {
		id,
		providerId,
		username: `${providerId}-test`,
		password: 'test-password',
		createdAt: '2026-10-06T00:00:00.000Z',
		lastActiveAt: null,
		revokedAt: null,
		grants: {},
	};
}

describe('agent providers', () => {
	test('keeps the supported provider IDs unique and serves bundled favicons', async () => {
		const ids = AGENT_PROVIDERS.map((provider) => provider.id);

		expect(ids).toEqual(['grok-bot', 'muse', 'instinct', 'dot']);
		expect(new Set(ids).size).toBe(ids.length);
		for (const provider of AGENT_PROVIDERS) {
			expect(agentProvider(provider.id)).toBe(provider);
			expect(provider.faviconUrl).toStartWith('/agent-providers/');
			const assetUrl = new URL(`../../public${provider.faviconUrl}`, import.meta.url);
			expect(await Bun.file(assetUrl).exists()).toBe(true);
		}
	});
});

describe('addAgent', () => {
	test('adds a new provider login with no access', () => {
		const existing = [login('muse')];
		const added = addAgent(existing, 'dot', (providerId) => login(providerId, 'new-dot'));

		expect(added.created).toBe(true);
		expect(added.agent.id).toBe('new-dot');
		expect(added.agent.grants).toEqual({});
		expect(added.agents.map((agent) => agent.providerId)).toEqual(['dot', 'muse']);
	});

	test('returns the existing login without calling the factory', () => {
		const existing = login('instinct');
		let factoryCalled = false;
		const added = addAgent([existing], 'instinct', (providerId) => {
			factoryCalled = true;
			return login(providerId, 'duplicate');
		});

		expect(added.created).toBe(false);
		expect(added.agent).toBe(existing);
		expect(added.agents).toEqual([existing]);
		expect(factoryCalled).toBe(false);
	});

	test('keeps a revoked provider unavailable until its login is deleted', () => {
		const revoked = {...login('grok-bot'), revokedAt: '2026-10-06T01:00:00.000Z'};
		const duplicate = addAgent([revoked], 'grok-bot', (providerId) => login(providerId));
		const recreated = addAgent([], 'grok-bot', (providerId) => login(providerId, 'replacement'));

		expect(duplicate.created).toBe(false);
		expect(recreated.created).toBe(true);
		expect(recreated.agent.id).toBe('replacement');
	});
});
