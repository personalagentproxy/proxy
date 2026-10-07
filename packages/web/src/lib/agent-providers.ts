export const AGENT_PROVIDERS = [
	{
		id: 'grok-bot',
		name: 'Grok Bot',
		company: 'SpaceXAI',
		faviconUrl: '/agent-providers/grok-bot.png',
	},
	{
		id: 'muse',
		name: 'Muse',
		company: 'Meta',
		faviconUrl: '/agent-providers/muse.svg',
	},
	{
		id: 'instinct',
		name: 'Instinct',
		company: 'Instinct',
		faviconUrl: '/agent-providers/instinct.png',
	},
	{
		id: 'dot',
		name: 'Dot',
		company: 'OpenAI',
		faviconUrl: '/agent-providers/dot.png',
	},
] as const;

export type AgentProvider = (typeof AGENT_PROVIDERS)[number];
export type AgentProviderId = AgentProvider['id'];

export function agentProvider(providerId: AgentProviderId): AgentProvider {
	const provider = AGENT_PROVIDERS.find((candidate) => candidate.id === providerId);
	if (!provider) {
		throw new Error(`Unknown agent provider ${providerId}`);
	}

	return provider;
}
