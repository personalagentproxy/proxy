export type AgentProviderId =
	'grok-bot' | 'muse' | 'instinct' | 'dot' | 'poke' | 'claude' | 'chatgpt';

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
	{
		id: 'poke',
		name: 'Poke',
		company: 'The Interaction Company',
		faviconUrl: '/agent-providers/poke.jpg',
	},
	{id: 'claude', name: 'Claude', company: 'Anthropic', faviconUrl: '/agent-providers/claude.png'},
	{id: 'chatgpt', name: 'ChatGPT', company: 'OpenAI', faviconUrl: '/agent-providers/chatgpt.png'},
];

export function findAgentProvider(id: string): AgentProvider | undefined {
	return AGENT_PROVIDERS.find((provider) => provider.id === id);
}

/**
 * The provider an MCP client's registered name points at, such as "Claude" or "ChatGPT", so
 * connecting one suggests its login. Names are the client's own, so this only ever suggests.
 */
export function suggestAgentProvider(clientName: string): AgentProvider | undefined {
	const name = clientName.toLowerCase();
	return AGENT_PROVIDERS.find((provider) => name.includes(provider.name.toLowerCase()));
}
