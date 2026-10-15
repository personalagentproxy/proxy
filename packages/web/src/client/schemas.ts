import {mcpToolSchema} from '@proxy/integrations';
import {z} from 'zod';

// The api's response shapes, shared by the human side's and the agent side's clients.

export const connectionSchema = z.object({
	id: z.string(),
	integrationId: z.string(),
	account: z.string(),
	// The actions agents get by default.
	defaults: z.array(z.string()),
	// A custom MCP server's tools, what its actions are; null for every other integration.
	tools: z.array(mcpToolSchema).nullable(),
	// What the person called the connection, where they named it; null for every other integration.
	name: z.string().nullable(),
	// The actions the connection's sign-in didn't cover: no agent gets them until it is signed in again.
	unavailable: z.array(z.string()),
});

export const agentSchema = z.object({
	id: z.string(),
	providerId: z.string(),
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
	// Where the person sees it in the provider's own app, as Gmail shows it, where it has one.
	url: z.string().optional(),
	// In a nested collection, whether it holds records of its own to list.
	hasChildren: z.boolean().optional(),
});

export const auditEntrySchema = z.object({
	id: z.string(),
	at: z.string(),
	// None for what Personal Agent Proxy did itself, as the home page's widgets write.
	agentId: z.string().nullable(),
	connectionId: z.string(),
	collectionId: z.string(),
	action: z.string(),
	recordTitle: z.string().nullable(),
	query: z.string().nullable(),
	outcome: z.enum(['allowed', 'denied']),
	// The web app's agent pages, or the MCP server.
	via: z.enum(['web', 'mcp']),
});
