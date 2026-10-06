import {
	effectiveAccess,
	findCollection,
	providerAccess,
	type Access,
	type Collection,
	type FieldType,
} from '@proxy/integrations';
import {formatDate, formatDateTime} from '@/lib/format';
import {findIntegration, type Integration} from '@/lib/integrations';
import type {AgentLogin, AuditEntry, Connection, DataRecord} from '@/lib/types';

export const ACCESS_LABELS: Record<Access, string> = {
	none: 'No access',
	read: 'Read',
	write: 'Read & write',
};

// The same levels as the agent reads them about itself.
export const AGENT_ACCESS_LABELS: Record<Access, string> = {
	none: 'No access',
	read: 'Read only',
	write: 'Read and write',
};

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

// What an agent without a setting of its own gets in a collection.
export function defaultAccess(connection: Connection, collectionId: string): Access {
	return (
		connection.collections.find((candidate) => candidate.id === collectionId)?.connectionDefault ??
		'none'
	);
}

// The agent's own setting for a collection, or null where it follows the default.
export function ownAccess(
	agent: AgentLogin,
	connectionId: string,
	collectionId: string,
): Access | null {
	const grant = agent.grants.find(
		(candidate) =>
			candidate.connectionId === connectionId && candidate.collectionId === collectionId,
	);
	return grant?.access ?? null;
}

// What the agent can do in the collection: its own setting, else the default, capped by the provider.
export function accessFor(
	agent: AgentLogin,
	connection: Connection,
	collection: Collection,
): Access {
	return effectiveAccess({
		provider: providerAccess(collection),
		connectionDefault: defaultAccess(connection, collection.id),
		agent: ownAccess(agent, connection.id, collection.id),
	});
}

// The agents, revoked ones left out, that can reach anything in the connection.
export function agentsWithAccess(agents: AgentLogin[], connection: Connection): AgentLogin[] {
	const collections = integrationOf(connection)?.collections ?? [];
	return agents.filter(
		(agent) =>
			agent.revokedAt === null &&
			collections.some((collection) => accessFor(agent, connection, collection) !== 'none'),
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

const ACTION_VERBS: Record<AuditEntry['action'], string> = {
	list: 'Listed',
	view: 'Viewed',
	create: 'Created',
	update: 'Updated',
	delete: 'Deleted',
};

// "Viewed email “Thursday sync moved?”", "Listed Payment cards", "Tried to list Contacts".
export function describeEntry(entry: AuditEntry, collection: Collection | undefined): string {
	const name = collection?.name ?? entry.collectionId;
	const singular = collection?.singular ?? 'record';
	if (entry.outcome === 'denied') {
		return `Tried to ${entry.action} ${entry.action === 'list' ? name : singular}`;
	}

	if (entry.action === 'list') {
		return `${ACTION_VERBS.list} ${name}`;
	}

	const title = entry.recordTitle ? ` “${entry.recordTitle}”` : '';
	return `${ACTION_VERBS[entry.action]} ${singular}${title}`;
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
