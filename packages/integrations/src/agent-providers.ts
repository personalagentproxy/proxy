export type AgentProviderId = 'grok-bot' | 'muse' | 'instinct' | 'dot';

export type AgentProvider = {
	id: AgentProviderId;
	name: string;
	company: string;
	/** Bundled with the web app, under `packages/web/public`. */
	faviconUrl: string;
};

// The agents an organization can make a login for, one each.
export const AGENT_PROVIDERS: AgentProvider[] = [
	{
		id: 'grok-bot',
		name: 'Grok Bot',
		company: 'SpaceXAI',
		faviconUrl: '/agent-providers/grok-bot.png',
	},
	{id: 'muse', name: 'Muse', company: 'Meta', faviconUrl: '/agent-providers/muse.svg'},
	{
		id: 'instinct',
		name: 'Instinct',
		company: 'Instinct',
		faviconUrl: '/agent-providers/instinct.png',
	},
	{id: 'dot', name: 'Dot', company: 'OpenAI', faviconUrl: '/agent-providers/dot.png'},
];

export function findAgentProvider(id: string): AgentProvider | undefined {
	return AGENT_PROVIDERS.find((provider) => provider.id === id);
}
