// What a showcase story is made of (stories.ts), which seed-showcase.ts writes as the api would
// have: connections, agent logins and what they did, personas and their threads, alerts.

/** The connections the showcase makes, or finds: the vault and Sandboxes come with the workspace. */
export type ConnectionKey = 'google' | 'support' | 'github' | 'linear' | 'notion' | 'granola' | 'observability' | 'plaid' | 'exa' | 'vault' | 'sandboxes' | 'arneCalendar' | 'handbook';

export type PersonaKey = 'general' | 'engineer' | 'oncall' | 'support' | 'shopping' | 'travel';

export type AgentKey = 'claudeCode' | 'devin' | 'claude' | 'chatgpt';

/**
 * One request an agent made: on a connection's collection, an action, with the record's title or
 * the query where the log shows one; allowed unless it says otherwise. A sandbox command names
 * the sandbox and the command, which the log keeps as its query.
 */
export type Act = {
	on: ConnectionKey;
	collection: string;
	action: string;
	title?: string;
	query?: string;
	outcome?: 'allowed' | 'denied' | 'failed';
	error?: string;
	ms?: number;
	sandbox?: string;
	command?: string;
};

/** A command run in one of the showcase's sandboxes, by its name. */
export function sh(sandbox: string, command: string, ms = 1800): Act {
	return {on: 'sandboxes', collection: 'tools', action: 'sandbox_exec', sandbox, command, ms};
}

/** A tool of the observability server, run with these params. */
export function tool(name: string, params: Record<string, string | number>, ms = 400): Act {
	return {on: 'observability', collection: 'tools', action: name, query: JSON.stringify(params), ms};
}

/**
 * What happens in a thread, minutes from when it opened: the person says something; an alert's
 * event comes; the agent runs a script, with the requests it made, tells the person something as
 * it goes, starts sub-agents, hears back from one (by its title), or answers, which ends its turn,
 * maybe setting an alert that comes back to the thread.
 */
export type Step =
	| {at: number; person: string}
	| {at: number; say?: string; script: string; result: string; acts: Act[]}
	| {at: number; tell: string}
	| {at: number; say?: string; subAgents: SubAgent[]}
	| {at: number; report: string}
	| {at: number; answer: string; alert?: {title: string; brief: string; at: Date}};

/** A sub-agent a thread started: its steps are minutes from when it was started, the last its answer. */
export type SubAgent = {title: string; brief: string; steps: Step[]};

/** What a watch matched, as the connector reports a new record. */
export type Change = {id: string; title: string; url: string | null; summary: string};

/**
 * One of the person's threads with a persona: opened by what they said, or by an alert (a watch's
 * match, or a timed alert coming); where it stands, waiting for them or done (watching where an
 * alert comes back to it), and whether they have read what was said last.
 */
export type Thread = {
	persona: PersonaKey;
	title: string;
	start: Date;
	opened?: {alert: string; change?: Change};
	steps: Step[];
	waiting?: boolean;
	summary: string;
	unread?: boolean;
};

/** An alert that opens a new thread in the persona's chat, set in one of its threads. */
export type ChatAlert = {
	key: string;
	persona: PersonaKey;
	setIn: string;
	title: string;
	brief: string;
} & ({kind: 'watch'; collection: 'emails' | 'issues' | 'events'; on: ConnectionKey[]; terms: string[]; split: 'per_check' | 'per_record'} | {kind: 'timed'; at: Date; every: string; timeZone: string});

/** A task an outside agent did, or is still doing (no outcome), with the requests it made. */
export type AgentTask = {
	agent: AgentKey;
	title: string;
	goal: string;
	start: Date;
	minutes: number;
	outcome: string | null;
	via?: 'mcp' | 'cli';
	acts: Act[];
};
