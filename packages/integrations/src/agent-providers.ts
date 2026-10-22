export type AgentProviderId =
	| 'grok-bot'
	| 'muse'
	| 'instinct'
	| 'dot'
	| 'poke'
	| 'claude'
	| 'claude-duet'
	| 'claude-code'
	| 'claude-desktop'
	| 'hermes'
	| 'chatgpt'
	| 'custom'
	| 'proxy';

export type AgentProvider = {
	id: AgentProviderId;
	name: string;
	aliases?: string[];
	/** A distinct product that uses another provider's account-wide agent login. */
	loginProviderId?: AgentProviderId;
	company: string;
	/**
	 * How the agent gets its access: `mcp` adds Personal Agent Proxy as a connector and signs in
	 * over OAuth, which makes its login; `login` is handed a username and password; `built-in` is
	 * Personal Agent Proxy's own agent, which needs neither.
	 */
	connects: 'mcp' | 'login' | 'built-in';
	/**
	 * Runs on the person's own computer, so it reaches a Personal Agent Proxy there, such as one
	 * in development at `http://localhost`. Every other agent needs a public https address.
	 */
	local: boolean;
	/**
	 * A `login` agent that won't take a password typed in chat, and keeps it in a vault of its own
	 * instead: asked for one, it sends a link to a page the person fills the login in on.
	 */
	vault?: boolean;
	/**
	 * Any other agent that speaks MCP, named by the person rather than by its company, so an
	 * organization can have as many as it likes.
	 */
	custom?: boolean;
	/** Bundled with the web app, under `packages/web/public`. A custom agent has none. */
	faviconUrl?: string;
};

/**
 * The agents Personal Agent Proxy runs itself, on the Chat page: agent logins like any other for
 * their access and their activity, made on the Chat page, never handed out, so not among the
 * products a person can make a login for.
 */
export const BUILT_IN_AGENT_PROVIDER: AgentProvider = {
	id: 'proxy',
	name: 'Personal Agent Proxy',
	company: 'Personal Agent Proxy',
	connects: 'built-in',
	local: true,
	faviconUrl: '/favicon.svg',
};

// The agent products a person can connect, any number of logins of each. A product with a
// loginProviderId signs in through that provider's account, so its logins are that provider's.
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
		vault: true,
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
		id: 'claude-duet',
		name: 'Claude Duet',
		loginProviderId: 'claude',
		company: 'Anthropic',
		connects: 'mcp',
		local: false,
		faviconUrl: '/agent-providers/claude-duet.png',
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
		id: 'hermes',
		name: 'Hermes Agent',
		company: 'Nous Research',
		connects: 'mcp',
		local: true,
		faviconUrl: '/agent-providers/hermes.png',
	},
	{
		id: 'chatgpt',
		name: 'ChatGPT',
		company: 'OpenAI',
		connects: 'mcp',
		local: false,
		faviconUrl: '/agent-providers/chatgpt.png',
	},
	{
		id: 'custom',
		name: 'Custom MCP agent',
		company: 'Custom',
		connects: 'mcp',
		// It may well run on this computer, so it isn't greyed out over http.
		local: true,
		custom: true,
	},
];

/** A provider by id, the built-in agent's among them. */
export function findAgentProvider(id: string): AgentProvider | undefined {
	if (id === BUILT_IN_AGENT_PROVIDER.id) {
		return BUILT_IN_AGENT_PROVIDER;
	}
	return AGENT_PROVIDERS.find((provider) => provider.id === id);
}

/** The provider id stored for a product's login. Some products share one account-wide login. */
export function loginProviderIdFor(provider: AgentProvider): AgentProviderId {
	return provider.loginProviderId ?? provider.id;
}

/** The longest name an agent can be given. */
export const AGENT_NAME_MAX = 60;

/**
 * The provider an MCP client's registered name points at, such as "Claude" or "ChatGPT", so
 * connecting one suggests its login. The longest name that fits wins, so "Claude Code" is Claude
 * Code and not Claude. Names are the client's own, so this only ever suggests; a client it points
 * at none of is a custom agent.
 */
export function suggestAgentProvider(clientName: string): AgentProvider | undefined {
	const name = clientName.toLowerCase();
	let best: {provider: AgentProvider; length: number} | undefined;
	for (const provider of AGENT_PROVIDERS.filter((candidate) => !candidate.custom)) {
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
	if (!best) {
		return undefined;
	}

	return findAgentProvider(loginProviderIdFor(best.provider));
}
