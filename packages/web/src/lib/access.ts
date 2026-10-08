import {
	effectiveActions,
	findCollection,
	requiredAction,
	type Action,
	type Collection,
	type Command,
	type FieldType,
	type OwnSettings,
} from '@proxy/integrations';
import {formatDate, formatDateTime} from '@/lib/format';
import {findIntegration, type Integration} from '@/lib/integrations';
import type {AgentLogin, AuditEntry, Connection, DataRecord} from '@/lib/types';

// The connection's integration, or null for one the catalog no longer has.
export function integrationOf(connection: {integrationId: string}): Integration | null {
	return findIntegration(connection.integrationId) ?? null;
}

// The integration's name, and the account too once the integration is connected more than once.
export function connectionLabel(connections: Connection[], connection: Connection): string {
	const name = integrationOf(connection)?.name ?? connection.integrationId;
	const siblings = connections.filter(
		(candidate) => candidate.integrationId === connection.integrationId,
	);
	if (siblings.length < 2) {
		return name;
	}
	return `${name} (${connection.account})`;
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

// What the agent can do with the connection: its own settings, else the defaults.
export function actionsFor(agent: AgentLogin, connection: Connection): string[] {
	const integration = integrationOf(connection);
	if (!integration) {
		return [];
	}
	return effectiveActions(
		integration,
		defaultActions(connection),
		ownSettings(agent, connection.id),
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

// Whether the actions allow a request: reading, a write, or one of the collection's commands.
export function allows(collection: Collection, actions: string[], request: string): boolean {
	const needed = requiredAction(collection, request);
	return needed !== null && actions.includes(needed);
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

// The connection and collection an audit entry is about, while both still exist.
export function locateEntry(
	connections: Connection[],
	entry: AuditEntry,
): {connection: Connection; collection: Collection} | null {
	const connection = connections.find((candidate) => candidate.id === entry.connectionId);
	const integration = connection && integrationOf(connection);
	const collection = integration && findCollection(integration, entry.collectionId);
	if (!connection || !collection) {
		return null;
	}
	return {connection, collection};
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

// "Viewed email “Thursday sync moved?”", "Listed Payment cards", "Searched Email for “invoice”",
// "Listed Pages in “Companies”", "Tried to list Contacts", and a command's own words: "Sent email
// “Re: Q3”", "Tried to send email". A list's record title is the record it was opened in.
export function describeEntry(entry: AuditEntry, collection: Collection | undefined): string {
	const name = collection?.name ?? entry.collectionId;
	const singular = collection?.singular ?? 'record';
	const denied = entry.outcome === 'denied';
	if (entry.action === 'list') {
		const where = entry.recordTitle ? `${name} in “${entry.recordTitle}”` : name;
		const what = entry.query ? `search ${where} for “${entry.query}”` : `list ${where}`;
		if (denied) {
			return `Tried to ${what}`;
		}
		return entry.query ? `Searched ${where} for “${entry.query}”` : `Listed ${where}`;
	}

	const record = entry.recordTitle ? `${singular} “${entry.recordTitle}”` : singular;
	const command = collection?.commands?.find((candidate) => candidate.id === entry.action);
	if (command) {
		return denied
			? `Tried to ${command.tried.replace('{}', singular)}`
			: command.done.replace('{}', record);
	}

	if (denied) {
		return `Tried to ${entry.action} ${singular}`;
	}
	return `${ACTION_VERBS[entry.action] ?? entry.action} ${record}`;
}

// What a row shows for a field: secrets down to their last four characters.
export function displayValue(type: FieldType, value: string | undefined): string {
	if (!value) {
		return '';
	}

	if (type === 'secret') {
		return `•••• ${value.replace(/\s/g, '').slice(-4)}`;
	}

	if (type === 'datetime') {
		return formatDateTime(value);
	}

	if (type === 'date') {
		return formatDate(`${value}T00:00`);
	}

	return value;
}
