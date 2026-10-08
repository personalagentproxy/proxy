export type AgentProviderId =
	| 'grok-bot'
	| 'muse'
	| 'instinct'
	| 'dot'
	| 'poke'
	| 'claude'
	| 'claude-code'
	| 'claude-desktop'
	| 'chatgpt';

export type AgentProvider = {
	id: AgentProviderId;
	name: string;
	aliases?: string[];
	company: string;
	/**
	 * How the agent gets its access: `mcp` adds Personal Agent Proxy as a connector and signs in
	 * over OAuth, which makes its login; `login` is handed a username and password.
	 */
	connects: 'mcp' | 'login';
	/**
	 * Runs on the person's own computer, so it reaches a Personal Agent Proxy there, such as one
	 * in development at `http://localhost`. Every other agent needs a public https address.
	 */
	local: boolean;
	/** Bundled with the web app, under `packages/web/public`. */
	faviconUrl: string;
};

// The agents an organization can make a login for, one each.
export const AGENT_PROVIDERS: AgentProvider[] = [
	{
		id: 'grok-bot',
		name: 'Grok Bot',
		company: 'SpaceXAI',
		connects: 'login',
		local: false,
		faviconUrl: '/agent-providers/grok-bot.png',
	},
	{
		id: 'muse',
		name: 'Muse',
		company: 'Meta',
		connects: 'login',
		local: false,
		faviconUrl: '/agent-providers/muse.png',
	},
	{
		id: 'instinct',
		name: 'Instinct',
		company: 'Instinct',
		connects: 'login',
		local: false,
		faviconUrl: '/agent-providers/instinct.png',
	},
	{
		id: 'dot',
		name: 'Dots',
		aliases: ['Dot'],
		company: 'OpenAI',
		connects: 'login',
		local: false,
		faviconUrl: '/agent-providers/dot.png',
	},
	{
		id: 'poke',
		name: 'Poke',
		company: 'The Interaction Company',
		connects: 'mcp',
		local: false,
		faviconUrl: '/agent-providers/poke.png',
	},
	{
		id: 'claude',
		name: 'Claude',
		company: 'Anthropic',
		connects: 'mcp',
		local: false,
		faviconUrl: '/agent-providers/claude.png',
	},
	{
		id: 'claude-code',
		name: 'Claude Code',
		company: 'Anthropic',
		connects: 'mcp',
		local: true,
		faviconUrl: '/agent-providers/claude-code.png',
	},
	{
		id: 'claude-desktop',
		name: 'Claude Desktop',
		company: 'Anthropic',
		connects: 'mcp',
		local: true,
		faviconUrl: '/agent-providers/claude-desktop.png',
	},
	{
		id: 'chatgpt',
		name: 'ChatGPT',
		company: 'OpenAI',
		connects: 'mcp',
		local: false,
		faviconUrl: '/agent-providers/chatgpt.png',
	},
];

export function findAgentProvider(id: string): AgentProvider | undefined {
	return AGENT_PROVIDERS.find((provider) => provider.id === id);
}

/**
 * The provider an MCP client's registered name points at, such as "Claude" or "ChatGPT", so
 * connecting one suggests its login. The longest name that fits wins, so "Claude Code" is Claude
 * Code and not Claude. Names are the client's own, so this only ever suggests.
 */
export function suggestAgentProvider(clientName: string): AgentProvider | undefined {
	const name = clientName.toLowerCase();
	let best: {provider: AgentProvider; length: number} | undefined;
	for (const provider of AGENT_PROVIDERS) {
		for (const candidate of [provider.name, ...(provider.aliases ?? [])]) {
			if (!name.includes(candidate.toLowerCase())) {
				continue;
			}
			if (best && best.length >= candidate.length) {
				continue;
			}
			best = {provider, length: candidate.length};
		}
	}
	return best?.provider;
}
