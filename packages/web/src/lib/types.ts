import type {Access} from '@proxy/integrations';

export type Connection = {
	id: string;
	integrationId: string;
	account: string;
	connectedAt: string;
};

export type DataRecord = {
	id: string;
	connectionId: string;
	collectionId: string;
	values: Record<string, string>;
	updatedAt: string;
};

export type AgentLogin = {
	id: string;
	name: string;
	username: string;
	password: string;
	createdAt: string;
	lastActiveAt: string | null;
	revokedAt: string | null;
	// Keyed by `grantKey(connectionId, collectionId)`; a missing key is no access.
	grants: Record<string, Access>;
};

export type AuditAction = 'list' | 'view' | 'create' | 'update' | 'delete';

export type AuditEntry = {
	id: string;
	at: string;
	agentId: string;
	connectionId: string;
	collectionId: string;
	action: AuditAction;
	// The record's title at the time, for actions on one record.
	recordTitle: string | null;
	outcome: 'allowed' | 'denied';
};
