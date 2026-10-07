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

export const AGENT_PROVIDER_IDS = ['grok-bot', 'muse', 'instinct', 'dot'] as const;

export type AgentProvider = (typeof AGENT_PROVIDERS)[number];
export type AgentProviderId = (typeof AGENT_PROVIDER_IDS)[number];

export function findAgentProvider(id: string): AgentProvider | undefined {
	return AGENT_PROVIDERS.find((provider) => provider.id === id);
}
