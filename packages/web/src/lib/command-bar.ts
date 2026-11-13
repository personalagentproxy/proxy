import type {AgentLogin} from '@proxy/contracts/agents';
import type {Connection} from '@proxy/contracts/connections';
import type {ChatPersona} from '@proxy/contracts/harness';
import {
	BellIcon,
	ChartNoAxesGanttIcon,
	ListChecksIcon,
	type LucideIcon,
	MessageSquareIcon,
	PlugIcon,
	PlusIcon,
	SettingsIcon,
	UserRoundIcon,
	UsersRoundIcon,
} from 'lucide-react';
import {connectionLabel} from '@/lib/access';
import {integrationOf} from '@/lib/integrations';
import {accountPath} from '@/lib/orgs';

/**
 * What the command bar works out itself, without the api: where what is typed leads (a page, a
 * conversation, a connection, an external agent), and which of Chat's agents a message is for.
 */

/**
 * The history state of a page the bar went to, so the page can tell it was picked there: Chat
 * then puts the caret in the conversation's input, as a click in its list does.
 */
export const FROM_COMMAND_BAR = 'command-bar';

/** Somewhere the bar goes: what it is called, where it is, and what is drawn beside it. */
export type Destination = {
	id: string;
	kind: 'page' | 'chat' | 'connection' | 'agent' | 'action';
	label: string;
	// What tells it from one called the same: a connection's account.
	detail: string | null;
	// Null for an action, which does something where the bar is rather than going anywhere.
	to: string | null;
	// What else finds it, beside its label and detail.
	keywords: string[];
	mark:
		| {kind: 'icon'; icon: LucideIcon}
		| {kind: 'theme'}
		| {kind: 'persona'; persona: ChatPersona}
		| {kind: 'connection'; connection: Connection}
		| {kind: 'agent'; providerId: string};
};

/** What a destination's kind is called, at the end of its row. */
export const KIND_NAMES: Record<Destination['kind'], string> = {
	page: 'Page',
	chat: 'Chat',
	connection: 'Connection',
	agent: 'External agent',
	action: '',
};

type Page = {
	label: string;
	to: (org: string) => string;
	icon: LucideIcon;
	keywords: string[];
};

/** The action that switches the theme between light and dark, whichever it is now. */
export const TOGGLE_THEME_LABEL = 'Toggle theme';

/** The id of a destination's row in the bar, which the bar's input names as the one Enter opens. */
export function rowId(destination: Destination): string {
	return `go-${destination.id}`;
}

// The app's pages, the sidebar's first, then what is under the organization's mark and the
// person's account, then the two that add something.
const PAGES: Page[] = [
	{
		label: 'Chat',
		to: (org) => `/${org}/chat`,
		icon: MessageSquareIcon,
		keywords: ['conversations', 'messages'],
	},
	{
		label: 'Connections and permissions',
		to: (org) => `/${org}/connections`,
		icon: PlugIcon,
		keywords: ['sources', 'integrations', 'access'],
	},
	{
		label: 'External agents',
		to: (org) => `/${org}/agents`,
		icon: ListChecksIcon,
		keywords: ['logins', 'mcp'],
	},
	{
		label: 'Activity',
		to: (org) => `/${org}/activity`,
		icon: ChartNoAxesGanttIcon,
		keywords: ['log', 'timeline', 'tasks', 'history'],
	},
	{
		label: 'Alerts',
		to: (org) => `/${org}/alerts`,
		icon: BellIcon,
		keywords: ['reminders', 'watches'],
	},
	{
		label: 'Members',
		to: (org) => `/${org}/members`,
		icon: UsersRoundIcon,
		keywords: ['people', 'team', 'invite', 'invitations'],
	},
	{
		label: 'Organization settings',
		to: (org) => `/${org}/settings`,
		icon: SettingsIcon,
		keywords: ['rename', 'leave', 'delete'],
	},
	{
		label: 'Account',
		to: (org) => accountPath(org),
		icon: UserRoundIcon,
		keywords: ['profile', 'sessions', 'sign out', 'notifications', 'theme', 'claude'],
	},
	{
		label: 'Add a connection',
		to: (org) => `/${org}/connections/new`,
		icon: PlusIcon,
		keywords: ['connect', 'new', 'source', 'integration'],
	},
	{
		label: 'Connect an external agent',
		to: (org) => `/${org}/agents/new`,
		icon: PlusIcon,
		keywords: ['login', 'mcp'],
	},
];

// A connection's account beside what it is called, where that says something more: not for a
// vault or the sandboxes, whose account is the organization, nor where the label has it already.
function accountOf(connection: Connection, label: string): string | null {
	if (integrationOf(connection)?.native || label.includes(connection.account)) {
		return null;
	}
	return connection.account;
}

/**
 * Everywhere the bar goes in the organization `org`: its pages, the person's conversations with
 * Chat's agents, their connections, and the external agents that aren't revoked. A list still
 * loading, or that couldn't be, is left out.
 */
export function destinationsOf(lists: {
	org: string;
	personas: ChatPersona[] | null;
	connections: Connection[] | null;
	agents: AgentLogin[] | null;
}): Destination[] {
	const {org} = lists;
	const connections = lists.connections ?? [];
	return [
		...PAGES.map((page): Destination => ({
			id: `page:${page.label}`,
			kind: 'page',
			label: page.label,
			detail: null,
			to: page.to(org),
			keywords: page.keywords,
			mark: {kind: 'icon', icon: page.icon},
		})),
		{
			id: 'action:toggle-theme',
			kind: 'action',
			label: TOGGLE_THEME_LABEL,
			detail: null,
			to: null,
			keywords: ['dark', 'light', 'mode', 'appearance'],
			mark: {kind: 'theme'},
		},
		...(lists.personas ?? []).map((persona): Destination => ({
			id: `chat:${persona.id}`,
			kind: 'chat',
			label: persona.name,
			detail: null,
			to: `/${org}/chat/${persona.id}`,
			keywords: ['agent', 'chat'],
			mark: {kind: 'persona', persona},
		})),
		...connections.map((connection): Destination => {
			const label = connectionLabel(connections, connection);
			return {
				id: `connection:${connection.id}`,
				kind: 'connection',
				label,
				detail: accountOf(connection, label),
				to: `/${org}/connections/${connection.id}`,
				keywords: [integrationOf(connection)?.name ?? '', connection.account],
				mark: {kind: 'connection', connection},
			};
		}),
		...(lists.agents ?? [])
			.filter((agent) => agent.revokedAt === null)
			.map((agent): Destination => ({
				id: `agent:${agent.id}`,
				kind: 'agent',
				label: agent.name,
				detail: null,
				to: `/${org}/agents/${agent.id}`,
				keywords: [agent.providerId],
				mark: {kind: 'agent', providerId: agent.providerId},
			})),
	];
}

// The words of a text, lowercased: letters and digits, with what an address is written with.
function wordsOf(text: string): string[] {
	return text
		.toLowerCase()
		.split(/[^\p{L}\p{N}@._-]+/u)
		.filter((word) => word !== '');
}

// How well a destination fits what is typed: 0 where its label starts with it, 1 where every
// word typed starts a word of its label, 2 where its detail or keywords are needed too; null
// where a word typed starts none of them.
function fit(typed: string, words: string[], destination: Destination): number | null {
	const label = destination.label.toLowerCase();
	if (label.startsWith(typed)) {
		return 0;
	}
	const inLabel = wordsOf(label);
	const starts = (among: string[]) => (word: string) =>
		among.some((candidate) => candidate.startsWith(word));
	if (words.every(starts(inLabel))) {
		return 1;
	}
	const all = [
		...inLabel,
		...wordsOf([destination.detail ?? '', ...destination.keywords].join(' ')),
	];
	return words.every(starts(all)) ? 2 : null;
}

/**
 * The destinations what is typed leads to, the best fit first and otherwise in their order: those
 * every word typed starts a word of, so "conn perm" finds Connections and permissions, and a whole
 * sentence, which is for a quick action or an agent, finds none.
 */
export function findDestinations(typed: string, destinations: Destination[]): Destination[] {
	const text = typed.trim().toLowerCase();
	const words = wordsOf(text);
	if (words.length === 0) {
		return [];
	}
	return destinations
		.flatMap((destination, index) => {
			const rank = fit(text, words, destination);
			return rank === null ? [] : [{destination, rank, index}];
		})
		.toSorted((a, b) => a.rank - b.rank || a.index - b.index)
		.map(({destination}) => destination);
}

// A persona's name as a pattern: as written, whatever the case and the spaces between its words,
// and not as part of a longer word.
function namePattern(persona: ChatPersona): string {
	const name = persona.name
		.trim()
		.split(/\s+/)
		.map((word) => word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
		.join('\\s+');
	return `(?<![\\p{L}\\p{N}])${name}(?![\\p{L}\\p{N}])`;
}

// The personas, the longest name first, so "Finance team" is found before "Finance".
function byNameLength(personas: ChatPersona[]): ChatPersona[] {
	return personas
		.filter((persona) => persona.name.trim() !== '')
		.toSorted((a, b) => b.name.length - a.name.length);
}

/** A text said to an agent by name: the agent, and what is said to it, without its name. */
export type Addressed = {persona: ChatPersona; message: string};

// What may come before an agent's name when it is asked something, "ask my Finance agent …", and
// after it, as patterns; and that what follows the name isn't only the word after it, "ask
// Finance agent" being still on its way to what is asked.
const BEFORE_NAME = '(?:(?:my|our|the)\\s+)?';
const AFTER_NAME = '(?:\\s+(?:agent|assistant|bot))?';
const NOT_ONLY_AFTER_NAME = '(?!(?:agent|assistant|bot)\\s*$)';

// Each persona's patterns, the longest name first: whether a text is said to it, with what is
// said to it, and whether a text names it. Made once for a list of them, rather than each time
// a text is looked at, which is every keystroke.
type Patterns = {persona: ChatPersona; said: RegExp; named: RegExp};

const patternsFor = new WeakMap<ChatPersona[], Patterns[]>();

function patternsOf(personas: ChatPersona[]): Patterns[] {
	const made = patternsFor.get(personas);
	if (made) {
		return made;
	}
	const patterns = byNameLength(personas).map((persona): Patterns => {
		const name = `${namePattern(persona)}${AFTER_NAME}`;
		return {
			persona,
			said: new RegExp(
				`^\\s*(?:@${name}[\\s,:]*|(?:ask|tell|message|ping|hey|hi)\\s+${BEFORE_NAME}@?${name}[\\s,:]*(?:(?:to|that)\\s+)?|${name}\\s*[,:]\\s*)${NOT_ONLY_AFTER_NAME}(\\S.*)$`,
				'isu',
			),
			named: new RegExp(namePattern(persona), 'iu'),
		};
	});
	patternsFor.set(personas, patterns);
	return patterns;
}

/**
 * The persona a text is said to, by name, and what is said to it: "@Finance …", "ask Finance …",
 * "tell Finance …", "Finance, …" or "Finance: …", the name also as "my Finance agent". Such a text
 * is a message to that agent whatever else it reads like, so no quick action is looked for, and
 * the message is what follows the name: "ask Finance to pay the invoice" says "pay the invoice".
 * Null for any other text, and while nothing follows the name yet.
 */
export function addressedPersona(text: string, personas: ChatPersona[]): Addressed | null {
	for (const {persona, said} of patternsOf(personas)) {
		const message = said.exec(text)?.[1]?.trim();
		if (message) {
			return {persona, message};
		}
	}
	return null;
}

// The persona whose name a text has in it, the longest such name.
function mentionedPersona(text: string, personas: ChatPersona[]): ChatPersona | null {
	return patternsOf(personas).find(({named}) => named.test(text))?.persona ?? null;
}

// The persona a message goes to when it names none: General, which is the one every member
// sees, the oldest of them; without one, the conversation last active.
function defaultPersona(personas: ChatPersona[]): ChatPersona | null {
	const [general] = personas
		.filter((persona) => persona.shared)
		.toSorted((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
	return general ?? personas[0] ?? null;
}

/**
 * Which of Chat's agents a message no quick action does is for: the one it names, else General.
 * Null with no agent at all.
 */
export function personaFor(text: string, personas: ChatPersona[]): ChatPersona | null {
	return (
		addressedPersona(text, personas)?.persona ??
		mentionedPersona(text, personas) ??
		defaultPersona(personas)
	);
}
