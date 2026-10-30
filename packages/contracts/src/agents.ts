import {z} from 'zod';

/**
 * An organization's agent logins (`/api/orgs/:org/agents/…`): the ones the person sees, making,
 * renaming, sharing and revoking one, its own settings, and the MCP clients signed in as it.
 */

export const agentSchema = z.object({
	id: z.string(),
	providerId: z.string(),
	name: z.string(),
	username: z.string(),
	/** Shared with every member of its organization, rather than one member's own. */
	shared: z.boolean(),
	/** Who made it, kept once it is shared; null for one from before it was kept. */
	createdById: z.string().nullable(),
	/** Their name, or else their address, while they are still in its organization. */
	createdBy: z.string().nullable(),
	createdAt: z.string(),
	lastActiveAt: z.string().nullable(),
	revokedAt: z.string().nullable(),
	/**
	 * One per action where the agent has a setting of its own; every other action follows the
	 * connection's default.
	 */
	grants: z.array(z.object({connectionId: z.string(), actionId: z.string(), allowed: z.boolean()})),
});

export type AgentLogin = z.infer<typeof agentSchema>;

/** `GET agents`: the agents the person sees in the organization, its shared ones and their own. */
export const agentListSchema = z.object({agents: z.array(agentSchema)});

/**
 * `POST agents`: the agent's name, the person's, or else its provider's, which a custom agent has
 * none of. `shared` makes it every member's rather than the person's own.
 */
export const createAgentBodySchema = z.object({
	providerId: z.string(),
	name: z.string().optional(),
	shared: z.boolean().optional(),
});

/** A new password, sent this once: Personal Agent Proxy keeps its hash. */
export const agentPasswordSchema = z.object({password: z.string()});

/** The new agent, and the only time its password is sent. */
export const createdAgentSchema = agentPasswordSchema.extend({agent: agentSchema});

/** `PUT agents/:agentId/name`: what it is called here, in the activity log and to the agent itself. */
export const renameAgentBodySchema = z.object({name: z.string()});

/** `PUT agents/:agentId/revoked`: a revoked agent can't sign in, and is shown nothing it could reach before. */
export const setRevokedBodySchema = z.object({revoked: z.boolean()});

/**
 * `PUT agents/:agentId/grants/:connectionId`: the agent's own settings for actions of the
 * connection, such as `{actions: {send: false}}`; `null` returns an action to the connection's
 * default.
 */
export const setGrantsBodySchema = z.object({
	actions: z.record(z.string(), z.boolean().nullable()),
});

export const mcpClientSchema = z.object({
	id: z.string(),
	name: z.string(),
	connectedAt: z.string(),
	/**
	 * Who signed it in, by their name or address while they are in the organization; null once
	 * they have left it.
	 */
	connectedBy: z.string().nullable(),
	/** Signed in by the person asking, who may sign it out whether or not they may change the agent. */
	mine: z.boolean(),
});

export type McpClient = z.infer<typeof mcpClientSchema>;

/** `GET agents/:agentId/mcp-clients`: the MCP clients signed in as the agent, such as Claude, newest first. */
export const mcpClientListSchema = z.object({clients: z.array(mcpClientSchema)});
