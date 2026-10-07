import {
	effectiveActions,
	findCollection,
	matchingPreset,
	requiredAction,
	type Collection,
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

// The actions an agent without settings of its own gets in a collection.
export function defaultActions(connection: Connection, collectionId: string): string[] {
	return connection.collections.find((candidate) => candidate.id === collectionId)?.defaults ?? [];
}

// The agent's own settings for a collection, by action; the ones left out follow the default.
export function ownSettings(
	agent: AgentLogin,
	connectionId: string,
	collectionId: string,
): OwnSettings {
	return Object.fromEntries(
		agent.grants
			.filter((grant) => grant.connectionId === connectionId && grant.collectionId === collectionId)
			.map((grant) => [grant.actionId, grant.allowed]),
	);
}

// What the agent can do in the collection: its own settings, else the defaults, nothing without Read.
export function actionsFor(
	agent: AgentLogin,
	connection: Connection,
	collection: Collection,
): string[] {
	return effectiveActions(
		collection,
		defaultActions(connection, collection.id),
		ownSettings(agent, connection.id, collection.id),
	);
}

// What the actions add up to: a preset's name, such as Read & triage, else the actions by name.
export function summarizeActions(collection: Collection, actions: string[]): string {
	const preset = matchingPreset(collection, actions);
	if (preset) {
		return preset.label;
	}
	return `Custom: ${describeActions(collection, actions)}`;
}

// "Read, Write drafts": what an agent can do, as the agent side tells it.
export function describeActions(collection: Collection, actions: string[]): string {
	return collection.actions
		.filter((action) => actions.includes(action.id))
		.map((action) => action.label)
		.join(', ');
}

// Whether the actions allow a request: a write, or one of the collection's commands.
export function allows(collection: Collection, actions: string[], request: string): boolean {
	const needed = requiredAction(collection, request);
	return needed !== null && actions.includes(needed);
}

// The agents, revoked ones left out, that can reach anything in the connection.
export function agentsWithAccess(agents: AgentLogin[], connection: Connection): AgentLogin[] {
	const collections = integrationOf(connection)?.collections ?? [];
	return agents.filter(
		(agent) =>
			agent.revokedAt === null &&
			collections.some((collection) => actionsFor(agent, connection, collection).length > 0),
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

// "Viewed email “Thursday sync moved?”", "Listed Payment cards", "Tried to list Contacts", and a
// command's own words: "Sent draft “Re: Q3”", "Tried to send draft".
export function describeEntry(entry: AuditEntry, collection: Collection | undefined): string {
	const name = collection?.name ?? entry.collectionId;
	const singular = collection?.singular ?? 'record';
	const denied = entry.outcome === 'denied';
	if (entry.action === 'list') {
		return denied ? `Tried to list ${name}` : `Listed ${name}`;
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
