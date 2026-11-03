import type {AuditEntry} from '@proxy/contracts/activity';
import type {AgentLogin} from '@proxy/contracts/agents';
import type {Connection} from '@proxy/contracts/connections';
import type {DataRecord} from '@proxy/contracts/records';
import {
	effectiveActions,
	findCollection,
	requiredAction,
	type Action,
	type Collection,
	type Command,
	type FieldType,
	type OwnSettings,
	TOOLS_COLLECTION_ID,
} from '@proxy/integrations';
import {formatDate, formatDateTime} from '@/lib/format';
import {integrationOf, type Integration} from '@/lib/integrations';

export {integrationOf};

// The name the person gave the connection, else the integration's name, and the account too once
// the integration is connected more than once; and whose it is once the same account is, as the
// organization's vault is beside the person's own.
export function connectionLabel(connections: Connection[], connection: Connection): string {
	if (connection.name !== null) {
		return connection.name;
	}
	const name = integrationOf(connection)?.name ?? connection.integrationId;
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
	return `${name} (${connection.account}, ${connection.shared ? 'everyone’s' : 'yours'})`;
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

// The changes a defaults editor sends, as the api takes them: a connection's default is on or
// off, never "back to default", so nulls are dropped.
export function defaultsOnOrOff(actions: Record<string, boolean | null>): Record<string, boolean> {
	return Object.fromEntries(
		Object.entries(actions).flatMap(([id, allowed]) => (allowed === null ? [] : [[id, allowed]])),
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

// The agents, revoked ones left out, that can do anything with the connection.
export function agentsWithAccess(agents: AgentLogin[], connection: Connection): AgentLogin[] {
	return agents.filter(
		(agent) => agent.revokedAt === null && actionsFor(agent, connection).length > 0,
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
function describeToolRun(entry: AuditEntry, integration: Integration | undefined): string {
	const title =
		integration?.actions.find((action) => action.id === entry.action)?.label ?? entry.action;
	if (entry.outcome === 'denied') {
		return `Tried to run ${title}`;
	}
	if (entry.outcome === 'failed') {
		return `Failed to run ${title}`;
	}
	return entry.query ? `Ran ${title} with ${entry.query}` : `Ran ${title}`;
}

// "Viewed email “Thursday sync moved?”", "Listed Entries", "Searched Email for “invoice”",
// "Listed Pages in “Companies”", "Tried to list Contacts", "Failed to view issue", and a command's
// own words: "Sent email “Re: Q3”", "Tried to send email", "Failed to send email “Re: Q3”". A list's
// record title is the record it was opened in.
export function describeEntry(entry: AuditEntry, located: LocatedEntry | null): string {
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

// The action the request needed: a custom server's tool is its own, anything else the one its
// collection names for it. Null once the connection is gone.
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
