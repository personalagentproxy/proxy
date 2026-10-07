import {z} from 'zod';

// The api's response shapes, shared by the human side's and the agent side's clients.

export const connectionSchema = z.object({
	id: z.string(),
	integrationId: z.string(),
	account: z.string(),
	connectedAt: z.string(),
	// The actions agents get by default.
	defaults: z.array(z.string()),
});

export const agentSchema = z.object({
	id: z.string(),
	name: z.string(),
	username: z.string(),
	createdAt: z.string(),
	lastActiveAt: z.string().nullable(),
	revokedAt: z.string().nullable(),
	// The agent's own settings, one per action; every other action follows the default.
	grants: z.array(z.object({connectionId: z.string(), actionId: z.string(), allowed: z.boolean()})),
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
	action: z.string(),
	recordTitle: z.string().nullable(),
	outcome: z.enum(['allowed', 'denied']),
});
