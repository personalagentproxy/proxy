import {formatDate, formatDateTime} from '@/lib/format';
import {findCollection, type Access, type Collection, type FieldType} from '@proxy/integrations';
import {findIntegration, type Integration} from '@/lib/integrations';
import {grantKey, type MockState} from '@/lib/mock-data';
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

export function accessFor(agent: AgentLogin, connectionId: string, collectionId: string): Access {
	return agent.grants[grantKey(connectionId, collectionId)] ?? 'none';
}

// The connection's integration; every connection is made from one in the catalog.
export function integrationOf(connection: Connection): Integration {
	const integration = findIntegration(connection.integrationId);
	if (!integration) {
		throw new Error(`Unknown integration ${connection.integrationId}`);
	}
	return integration;
}

// The integration's name, and the account too once the integration is connected more than once.
export function connectionLabel(state: MockState, connection: Connection): string {
	const {name} = integrationOf(connection);
	const siblings = state.connections.filter(
		(candidate) => candidate.integrationId === connection.integrationId,
	);
	if (siblings.length < 2) {
		return name;
	}
	return `${name} (${connection.account})`;
}

export type Located = {connection: Connection; integration: Integration; collection: Collection};

// A connection and one of its collections from the ids in a URL or an audit entry.
export function locate(
	state: MockState,
	connectionId: string,
	collectionId: string,
): Located | null {
	const connection = state.connections.find((candidate) => candidate.id === connectionId);
	if (!connection) {
		return null;
	}

	const integration = integrationOf(connection);
	const collection = findCollection(integration, collectionId);
	if (!collection) {
		return null;
	}

	return {connection, integration, collection};
}

export function recordsOf(
	state: MockState,
	connectionId: string,
	collectionId: string,
): DataRecord[] {
	return state.records.filter(
		(record) => record.connectionId === connectionId && record.collectionId === collectionId,
	);
}

export function recordTitle(collection: Collection, record: DataRecord): string {
	const title = record.values[collection.titleField]?.trim();
	if (!title) {
		return `Untitled ${collection.singular}`;
	}
	return title;
}

// The connections an agent can reach anything in, each with the collections it can reach.
export function reachable(
	state: MockState,
	agent: AgentLogin,
): Array<{
	connection: Connection;
	integration: Integration;
	collections: Array<{collection: Collection; access: Access}>;
}> {
	return state.connections
		.map((connection) => {
			const integration = integrationOf(connection);
			const collections = integration.collections
				.map((collection) => ({collection, access: accessFor(agent, connection.id, collection.id)}))
				.filter(({access}) => access !== 'none');
			return {connection, integration, collections};
		})
		.filter(({collections}) => collections.length > 0);
}

// How many agents can reach anything in the connection, revoked ones left out.
export function agentsWithAccess(state: MockState, connectionId: string): AgentLogin[] {
	const prefix = `${connectionId}/`;
	return state.agents.filter(
		(agent) =>
			agent.revokedAt === null &&
			Object.entries(agent.grants).some(
				([key, access]) => key.startsWith(prefix) && access !== 'none',
			),
	);
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

// What the provider fills in on a new record: the connected account as its sender, now as when
// it arrived or changed.
export function withSystemValues(
	collection: Collection,
	connection: Connection,
	values: Record<string, string>,
): Record<string, string> {
	const now = new Date();
	now.setMinutes(now.getMinutes() - now.getTimezoneOffset());
	const filled = {...values};
	for (const field of collection.fields.filter((candidate) => candidate.system)) {
		if (field.type === 'email') {
			filled[field.key] = connection.account;
		}
		if (field.type === 'datetime') {
			filled[field.key] = now.toISOString().slice(0, 16);
		}
	}
	return filled;
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
