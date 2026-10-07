import {ACCESS_LEVELS} from '@proxy/integrations';
import {z} from 'zod';

// The api's response shapes, shared by the human side's and the agent side's clients.

export const accessSchema = z.enum(ACCESS_LEVELS);

export const connectionSchema = z.object({
	id: z.string(),
	integrationId: z.string(),
	account: z.string(),
	connectedAt: z.string(),
	collections: z.array(
		z.object({id: z.string(), provider: accessSchema, connectionDefault: accessSchema}),
	),
});

export const agentSchema = z.object({
	id: z.string(),
	providerId: z.string().nullable(),
	name: z.string(),
	username: z.string(),
	createdAt: z.string(),
	lastActiveAt: z.string().nullable(),
	revokedAt: z.string().nullable(),
	grants: z.array(
		z.object({connectionId: z.string(), collectionId: z.string(), access: accessSchema}),
	),
});

export const dataRecordSchema = z.object({
	id: z.string(),
	values: z.record(z.string(), z.string()),
	updatedAt: z.string(),
});

export const auditEntrySchema = z.object({
	id: z.string(),
	at: z.string(),
	agentId: z.string(),
	connectionId: z.string(),
	collectionId: z.string(),
	action: z.enum(['list', 'view', 'create', 'update', 'delete']),
	recordTitle: z.string().nullable(),
	query: z.string().nullable(),
	outcome: z.enum(['allowed', 'denied']),
});
