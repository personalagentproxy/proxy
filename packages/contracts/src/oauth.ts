import {z} from 'zod';

/**
 * Connecting an MCP client, such as Claude, as one of the person's agents (`/api/oauth/…`): the api
 * checked the client's request and sealed it into the consent page's address, `request`.
 */

/** `GET /api/oauth/request?request=…`: who is asking, for the consent page. */
export const authorizationRequestSchema = z.object({
	clientName: z.string(),
	/** Where the browser goes back to, so the person can tell which app is asking. */
	redirectHost: z.string(),
	/** The agent the client's name points at, such as Claude, if it has one; else it is a custom one. */
	suggestedProviderId: z.string().nullable(),
});

export type AuthorizationRequest = z.infer<typeof authorizationRequestSchema>;

const declineSchema = z.object({allow: z.literal(false)});
const asAgentSchema = z.object({
	allow: z.literal(true),
	org: z.string(),
	agentId: z.string().min(1),
});
const asNewAgentSchema = z.object({
	allow: z.literal(true),
	org: z.string(),
	providerId: z.string().min(1),
	name: z.string().optional(),
});

/**
 * The person's answer: declined, or allowed as an existing agent or as a new login for a provider,
 * named by the person for a custom agent, in the organization `org`, by its slug, where the agent
 * is or a new one goes in.
 */
export const consentSchema = z.union([declineSchema, asAgentSchema, asNewAgentSchema]);

export type Consent = z.infer<typeof consentSchema>;

const sealedRequest = {request: z.string()};

/** `POST /api/oauth/consent`: the answer, with the sealed request it answers. */
export const consentBodySchema = z.union([
	declineSchema.extend(sealedRequest),
	asAgentSchema.extend(sealedRequest),
	asNewAgentSchema.extend(sealedRequest),
]);

/** Where the browser goes next: back to the client, with a code or `access_denied`. */
export const consentAnswerSchema = z.object({redirectTo: z.string()});
