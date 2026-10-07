import type {LucideIcon} from 'lucide-react';
import type {AgentProviderId} from '@/lib/agent-providers';

// `secret` reads like text but is masked to its last four characters wherever a row summarizes it.
export type FieldType = 'text' | 'longtext' | 'email' | 'datetime' | 'date' | 'select' | 'secret';

export type Field = {
	key: string;
	label: string;
	type: FieldType;
	options?: string[];
	// Set by the provider rather than typed in, such as when an email arrived: shown, never edited.
	system?: boolean;
};

export type Collection = {
	id: string;
	name: string;
	// One record of the collection, lowercase, for the audit log: "Viewed email …".
	singular: string;
	fields: Field[];
	// The field a row shows as its title, and the one it shows beside it.
	titleField: string;
	summaryField?: string;
};

export type Integration = {
	id: string;
	name: string;
	description: string;
	logoUrl: string;
	icon: LucideIcon;
	collections: Collection[];
	// The account a mock connection is made with, standing in for the provider's sign-in.
	sampleAccount: string;
	// Information lives in Proxy itself: it is always there and never connected or disconnected.
	builtIn?: boolean;
};

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

export type Access = 'none' | 'read' | 'write';

export type AgentLogin = {
	id: string;
	providerId: AgentProviderId;
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
