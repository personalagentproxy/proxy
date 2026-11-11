import type {AuditEntry} from '@proxy/contracts/activity';
import type {AgentLogin} from '@proxy/contracts/agents';
import type {Connection} from '@proxy/contracts/connections';
import type {Member} from '@proxy/contracts/orgs';
import type {DataRecord} from '@proxy/contracts/records';
import {
	API_REQUESTS_ID,
	effectiveActions,
	FILES_INTEGRATION_ID,
	findCollection,
	GIT_REQUESTS_ID,
	requiredAction,
	type Action,
	type Collection,
	type Command,
	type FieldType,
	type OwnSettings,
	TOOLS_COLLECTION_ID,
	VAULT_INTEGRATION_ID,
} from '@proxy/integrations';
import {findAgentProvider} from '@proxy/utils/agent-providers';
import {formatDate, formatDateTime} from '@/lib/format';
import {integrationOf, type Integration} from '@/lib/integrations';

export {integrationOf};

// What the person's built-in vault and drive are called: neither has a name of its own, and
// "Vault" or "Files" alone would say nothing beside those members made, each called by its name.
const OWN: Record<string, string> = {
	[VAULT_INTEGRATION_ID]: 'My vault',
	[FILES_INTEGRATION_ID]: 'My files',
};

/**
 * What a connection is called: the name the person gave it, their built-in vault "My vault" and
 * drive "My files", else its integration.
 */
export function connectionTitle(connection: Connection): string {
	if (connection.name !== null) {
		return connection.name;
	}
	const own = connection.builtIn ? OWN[connection.integrationId] : undefined;
	if (own !== undefined) {
		return own;
	}
	return integrationOf(connection)?.name ?? connection.integrationId;
}

// What the connection is called (`connectionTitle`), and for one called by its integration, the
// account too once the integration is connected more than once; and whether it is shared once the
// same account is, as one a member shared is beside the person's own.
export function connectionLabel(connections: Connection[], connection: Connection): string {
	const name = connectionTitle(connection);
	if (connection.name !== null || (connection.builtIn && name === OWN[connection.integrationId])) {
		return name;
	}
	const siblings = connections.filter(
		(candidate) => candidate.integrationId === connection.integrationId,
	);
	if (siblings.length < 2) {
		return name;
	}
	const sameAccount = siblings.filter((candidate) => candidate.account === connection.account);
	if (sameAccount.length < 2) {
		return `${name} (${connection.account})`;
	}
	return `${name} (${connection.account}, ${connection.shared ? 'shared' : 'yours'})`;
}

// The actions an agent without settings of its own gets.
export function defaultActions(connection: Connection): string[] {
	return connection.defaults;
}

// The agent's own settings for a connection, by action; the ones left out follow the default.
export function ownSettings(agent: AgentLogin, connectionId: string): OwnSettings {
	return Object.fromEntries(
		agent.grants
			.filter((grant) => grant.connectionId === connectionId)
			.map((grant) => [grant.actionId, grant.allowed]),
	);
}

// What the agent can do with the connection: its own settings, else the defaults, never what the
// connection's sign-in didn't cover.
export function actionsFor(agent: AgentLogin, connection: Connection): string[] {
	const integration = integrationOf(connection);
	if (!integration) {
		return [];
	}
	return effectiveActions(
		integration,
		defaultActions(connection),
		ownSettings(agent, connection.id),
		connection.unavailable,
	);
}

// "Read, Archive, Send": what the actions are called, in the catalog's order.
export function describeActions(integration: {actions: Action[]}, actions: string[]): string {
	return integration.actions
		.filter((action) => actions.includes(action.id))
		.map((action) => action.label)
		.join(', ');
}

// Whether the actions allow a request: reading, a write, or one of the collection's commands,
// with the action it needs beside its own, as sending a reply needs Read.
export function allows(collection: Collection, actions: string[], request: string): boolean {
	const needed = requiredAction(collection, request);
	const beside = collection.commands?.find((command) => command.id === request)?.requires;
	return (
		needed !== null &&
		actions.includes(needed) &&
		(beside === undefined || actions.includes(beside))
	);
}

// The commands on values typed in that the actions allow, such as Send for a new email.
export function newCommands(collection: Collection, actions: string[]): Command[] {
	return (collection.commands ?? []).filter(
		(command) => command.on === 'new' && allows(collection, actions, command.id),
	);
}

// Whether the agent can start a new record here: create one, or run a command such as Send.
export function canStartNew(collection: Collection, actions: string[]): boolean {
	return allows(collection, actions, 'create') || newCommands(collection, actions).length > 0;
}

/** The organization's built-in agent, which every persona of the Chat page acts through. */
export function isBuiltInAgent(agent: Pick<AgentLogin, 'providerId'>): boolean {
	return findAgentProvider(agent.providerId)?.connects === 'built-in';
}

/**
 * Whether an agent the person sees reaches a connection they use, as the api decides it: their own
 * agent reaches all of them, a shared agent only the ones shared with every member, and the built-in
 * agent, which acts as whoever talks to it, all of them.
 */
export function reaches(agent: AgentLogin, connection: Connection): boolean {
	return !agent.shared || connection.sharedWithEveryone || isBuiltInAgent(agent);
}

// The agents, revoked ones left out, that reach the connection and can do anything with it.
export function agentsWithAccess(agents: AgentLogin[], connection: Connection): AgentLogin[] {
	return agents.filter(
		(agent) =>
			agent.revokedAt === null &&
			reaches(agent, connection) &&
			actionsFor(agent, connection).length > 0,
	);
}

// The connection an audit entry is about, while it still exists, with its integration and the
// collection the entry names, where the integration has it: a custom MCP server's tools have none.
export type LocatedEntry = {
	connection: Connection;
	integration: Integration;
	collection?: Collection;
};

export function locateEntry(
	connections: Connection[],
	entry: Pick<AuditEntry, 'connectionId' | 'collectionId'>,
): LocatedEntry | null {
	const connection = connections.find((candidate) => candidate.id === entry.connectionId);
	const integration = connection && integrationOf(connection);
	if (!connection || !integration) {
		return null;
	}
	const collection = findCollection(integration, entry.collectionId);
	return {connection, integration, ...(collection ? {collection} : {})};
}

export function recordTitle(collection: Collection, record: DataRecord): string {
	const title = record.values[collection.titleField]?.trim();
	if (!title) {
		return `Untitled ${collection.singular}`;
	}
	return title;
}

const ACTION_VERBS: Partial<Record<string, string>> = {
	list: 'Listed',
	view: 'Viewed',
	create: 'Created',
	update: 'Updated',
	delete: 'Deleted',
};

// A custom MCP server's tool, run as it is: "Ran Search docs with {"query":"invoices"}", "Tried to
// run Search docs", "Failed to run Search docs"; by the tool's name once the server is
// disconnected.
// How much of a tool run's params its line shows; the entry's dialog has them all.
const SHOWN_PARAMS = 200;

function shortened(text: string): string {
	return text.length <= SHOWN_PARAMS ? text : `${text.slice(0, SHOWN_PARAMS - 1)}…`;
}

function describeToolRun(entry: AuditEntry, integration: Integration | undefined): string {
	const title =
		integration?.actions.find((action) => action.id === entry.action)?.label ?? entry.action;
	if (entry.outcome === 'denied') {
		return `Tried to run ${title}`;
	}
	if (entry.outcome === 'failed') {
		return `Failed to run ${title}`;
	}
	return entry.query ? `Ran ${title} with ${shortened(entry.query)}` : `Ran ${title}`;
}

// Whether an entry is a request relayed to the provider as it is, by git or to its API, from a
// sandbox: its action is the integration's own, its record title the repository it named.
export function isRelayed(entry: Pick<AuditEntry, 'collectionId'>): boolean {
	return entry.collectionId === GIT_REQUESTS_ID || entry.collectionId === API_REQUESTS_ID;
}

// A git request: "Fetched acme/demo", "Pushed to acme/demo: fix-login", "Tried to push to
// acme/demo", "Failed to fetch acme/demo". Any action but a push's, to a branch or the default
// one, fetches.
function describeGit(entry: AuditEntry): string {
	const repository = entry.recordTitle ?? 'a repository';
	const pushing = entry.action === 'push' || entry.action === 'pushDefault';
	const what = pushing ? `push to ${repository}` : `fetch ${repository}`;
	if (entry.outcome === 'denied') {
		return `Tried to ${what}`;
	}
	if (entry.outcome === 'failed') {
		return `Failed to ${what}`;
	}
	if (!pushing) {
		return `Fetched ${repository}`;
	}
	return entry.query ? `Pushed to ${repository}: ${entry.query}` : `Pushed to ${repository}`;
}

// An API request, by its method and path: "POST /repos/acme/demo/pulls", "Tried POST
// /repos/acme/demo/pulls", "Failed GET /user".
function describeApiRequest(entry: AuditEntry): string {
	const request = entry.query ?? 'a request';
	if (entry.outcome === 'denied') {
		return `Tried ${request}`;
	}
	if (entry.outcome === 'failed') {
		return `Failed ${request}`;
	}
	return request;
}

// "Viewed email “Thursday sync moved?”", "Listed Entries", "Searched Email for “invoice”",
// "Listed Pages in “Companies”", "Tried to list Contacts", "Failed to view issue", and a command's
// own words: "Sent email “Re: Q3”", "Tried to send email", "Failed to send email “Re: Q3”". A list's
// record title is the record it was opened in.
export function describeEntry(entry: AuditEntry, located: LocatedEntry | null): string {
	if (entry.collectionId === GIT_REQUESTS_ID) {
		return describeGit(entry);
	}
	if (entry.collectionId === API_REQUESTS_ID) {
		return describeApiRequest(entry);
	}
	if (located?.integration.custom || entry.collectionId === TOOLS_COLLECTION_ID) {
		return describeToolRun(entry, located?.integration);
	}
	const collection = located?.collection;
	const name = collection?.name ?? entry.collectionId;
	const singular = collection?.singular ?? 'record';
	const denied = entry.outcome === 'denied';
	if (entry.action === 'list') {
		const where = entry.recordTitle ? `${name} in “${entry.recordTitle}”` : name;
		const what = entry.query ? `search ${where} for “${entry.query}”` : `list ${where}`;
		if (denied) {
			return `Tried to ${what}`;
		}
		if (entry.outcome === 'failed') {
			return `Failed to ${what}`;
		}
		return entry.query ? `Searched ${where} for “${entry.query}”` : `Listed ${where}`;
	}

	const record = entry.recordTitle ? `${singular} “${entry.recordTitle}”` : singular;
	const command = collection?.commands?.find((candidate) => candidate.id === entry.action);
	if (command && denied) {
		return `Tried to ${command.tried.replace('{}', singular)}`;
	}
	if (command && entry.outcome === 'failed') {
		return `Failed to ${command.tried.replace('{}', record)}`;
	}
	if (command) {
		return command.done.replace('{}', record);
	}

	if (denied) {
		return `Tried to ${entry.action} ${singular}`;
	}
	if (entry.outcome === 'failed') {
		return `Failed to ${entry.action} ${record}`;
	}
	return `${ACTION_VERBS[entry.action] ?? entry.action} ${record}`;
}

const FAILURES: Partial<Record<string, string>> = {
	credentials_rejected: 'The service turned the connection’s sign-in down',
	provider_unreachable: 'The service couldn’t be reached',
	not_found: 'The service didn’t find it',
	validation_error: 'The service turned the request down',
	conflict: 'The service turned the request down',
	unavailable: 'The service turned the request down',
};

// What went wrong with a failed request, from the kind of error the api logged and the service's
// HTTP status where it answered with one: "The service couldn’t be reached (HTTP 503)", and too
// many requests in words of their own.
export function describeFailure(error: string | null): string {
	const [kind = '', status] = (error ?? '').split(' ');
	if (status === '429') {
		return 'The service turned it down for too many requests (HTTP 429)';
	}
	const words = FAILURES[kind] ?? 'Something went wrong';
	return status ? `${words} (HTTP ${status})` : words;
}

// The action the request needed: a custom server's tool is its own, as a relayed request's is,
// anything else the one its collection names for it. Null once the connection is gone.
export function entryAction(entry: AuditEntry, located: LocatedEntry | null): Action | null {
	if (!located) {
		return null;
	}
	const {integration, collection} = located;
	const id = collection ? requiredAction(collection, entry.action) : entry.action;
	return integration.actions.find((action) => action.id === id) ?? null;
}

// What a row shows for a field: dates and times as people read them.
export function displayValue(type: FieldType, value: string | undefined): string {
	if (!value) {
		return '';
	}

	if (type === 'datetime') {
		return formatDateTime(value);
	}

	if (type === 'date') {
		return formatDate(`${value}T00:00`);
	}

	return value;
}

/** "2 of 7 on", or all or none. */
export function howManyOn(on: number, total: number): string {
	if (on === 0) {
		return 'None on';
	}
	if (on === total) {
		return 'All on';
	}
	return `${on} of ${total} on`;
}

/** Actions under the name of the part of the provider they belong to, as Google's are Gmail's or Drive's; no name where the integration groups none. */
export type ActionGroup = {name: string | undefined; actions: Action[]};

/** The actions in runs of the group each names, in the catalog's order. */
export function groupsOf(actions: Action[]): ActionGroup[] {
	const groups: ActionGroup[] = [];
	for (const action of actions) {
		const last = groups.at(-1);
		if (last && last.name === action.group) {
			last.actions.push(action);
			continue;
		}
		groups.push({name: action.group, actions: [action]});
	}
	return groups;
}

/** Someone a connection is someone's or shared with: a member, or the name alone of someone the members' list no longer has. */
export type OrgPerson = {
	userId: string;
	name: string | null;
	email: string;
	image: string | null;
};

// A member by their id, or else what the connection itself says of them.
function personOf(userId: string, name: string, members: Member[]): OrgPerson {
	return (
		members.find((member) => member.userId === userId) ?? {userId, name, email: '', image: null}
	);
}

/** Whose a connection is: who connected it, and whose account agents act as. */
export function ownerOfConnection(connection: Connection, members: Member[]): OrgPerson {
	return personOf(connection.ownerUserId, connection.owner ?? 'A former member', members);
}

/**
 * Everyone but its owner who has the connection: every other member where it is shared with
 * everyone, else the members it is shared with by name, in the order it was shared with them.
 */
export function sharedWithPeople(connection: Connection, members: Member[]): OrgPerson[] {
	if (connection.sharedWithEveryone) {
		return members.filter((member) => member.userId !== connection.ownerUserId);
	}
	return connection.sharedWith.map((shared) => personOf(shared.userId, shared.name, members));
}
