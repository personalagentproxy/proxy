import {mcpToolSchema} from '@proxy/integrations';
import {EMAIL_PROVIDERS} from '@proxy/utils/email-providers';
import {z} from 'zod';

/**
 * An organization's connections (`/api/orgs/:org/connections/…`): the ones the person sees, and
 * connecting, renaming, sharing and setting the defaults of one.
 */

export const connectionSchema = z.object({
	id: z.string(),
	/** The organization it is in. */
	orgId: z.string(),
	integrationId: z.string(),
	account: z.string(),
	/** Shared with every member of its organization, rather than one member's own. */
	shared: z.boolean(),
	/** Who connected it, kept once it is shared; null for one from before it was kept. */
	connectedById: z.string().nullable(),
	/** Their name, or else their address, while they are still in its organization. */
	connectedBy: z.string().nullable(),
	/**
	 * The actions an agent without a setting of its own gets, in the catalog's order. An agent's own
	 * settings live on the agent.
	 */
	defaults: z.array(z.string()),
	/**
	 * A custom MCP server's tools, as the server last listed them: what its actions are. Null for
	 * every other integration.
	 */
	tools: z.array(mcpToolSchema).nullable(),
	/**
	 * What the person called the connection, where they named it; null for every other
	 * integration, which is called by its integration.
	 */
	name: z.string().nullable(),
	/**
	 * The actions the connection's sign-in didn't cover, in the catalog's order: no agent gets them
	 * until the person signs in again and allows them.
	 */
	unavailable: z.array(z.string()),
	/**
	 * The connection has no sign-in at all, as one moved over from a custom MCP server may not:
	 * every action is unavailable until the person signs in.
	 */
	signInNeeded: z.boolean(),
});

export type Connection = z.infer<typeof connectionSchema>;

/** `GET connections`: the connections the person sees in the organization, its shared ones and their own. */
export const connectionListSchema = z.object({connections: z.array(connectionSchema)});

const MAX_NAME_LENGTH = 80;

/**
 * `PUT connections/:connectionId/name`: an empty name is none of its own, so the connection shows
 * as its integration again.
 */
export const renameConnectionBodySchema = z.object({
	name: z
		.string()
		.trim()
		.max(MAX_NAME_LENGTH, `The name can be at most ${MAX_NAME_LENGTH} characters`),
});

/**
 * `PUT connections/:connectionId/defaults`: actions turned on or off for every agent without a
 * setting of its own, such as `{actions: {read: true, send: false}}`; actions left out stay as they
 * are.
 */
export const setDefaultsBodySchema = z.object({actions: z.record(z.string(), z.boolean())});

/** `shared` beside what a connect form sends: true shares the new connection with every member. */
export const shareBodySchema = z.object({shared: z.boolean().optional()});

/** Where a sign-in ends when not on the connection's page: the welcome flow or the home page it began from. */
export const returnToSchema = z.enum(['welcome', 'home']);

export type ReturnTo = z.infer<typeof returnToSchema>;

/** What a connection the person names is called, as the custom MCP form's is. */
export const connectionNameSchema = z
	.string()
	.trim()
	.min(1, 'Give the connection a name')
	.max(MAX_NAME_LENGTH, `The name can be at most ${MAX_NAME_LENGTH} characters`);

const hostnameSchema = z
	.string()
	.trim()
	.toLowerCase()
	.regex(/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/, 'Not a hostname');

/**
 * `POST connections/email/test`: a mailbox signed in to with an app password, saving nothing. Only
 * the standard mail ports, so a typed-in server can't point the api at anything else on its
 * network.
 */
export const mailboxBodySchema = z.object({
	provider: z.enum(EMAIL_PROVIDERS.map((provider) => provider.id)),
	email: z.string().trim().toLowerCase().pipe(z.email()),
	password: z.string().min(1),
	servers: z
		.object({
			imapHost: hostnameSchema,
			smtpHost: hostnameSchema,
			smtpPort: z.union([z.literal(465), z.literal(587)]),
		})
		.optional(),
});

/** `POST connections/email`: the mailbox connected, the person's own or, `shared`, every member's. */
export const connectEmailBodySchema = mailboxBodySchema.extend(shareBodySchema.shape);

/**
 * How a database connection is encrypted: verifying the server's certificate against the host's
 * name, encrypted but taking any certificate, as a self-signed one, or in the clear.
 */
export const TLS_MODES = ['verify', 'require', 'off'] as const;

// A host is a name or an address, in brackets when IPv6: no spaces, no path.
const hostSchema = z
	.string()
	.trim()
	.min(1)
	.max(253)
	.regex(/^[a-zA-Z0-9.\-:[\]]+$/, 'Not a host')
	.transform((host) => host.replace(/^\[(.*)\]$/, '$1'));

/**
 * `POST connections/<postgres|mysql>/test`: a database connection as typed in: the server, the
 * database and the user. The password may be empty, as a local database's can be.
 */
export const databaseBodySchema = z.object({
	host: hostSchema,
	port: z.number().int().min(1).max(65535),
	database: z.string().trim().min(1).max(200),
	username: z.string().trim().min(1).max(200),
	password: z.string().max(1000),
	tls: z.enum(TLS_MODES),
});

/** `POST connections/<postgres|mysql>`: the database connected, the person's own or, `shared`, every member's. */
export const connectDatabaseBodySchema = databaseBodySchema.extend(shareBodySchema.shape);

/**
 * `POST connections/mcp`: a custom MCP server by its address, under the name the person gives it,
 * with a token where the server takes one. A token is sent as a header, where a line break has no
 * place.
 */
export const connectMcpBodySchema = z.object({
	name: connectionNameSchema,
	url: z.string(),
	token: z
		.string()
		.trim()
		.regex(/^[^\r\n]*$/, 'The token can’t have line breaks')
		.optional(),
	returnTo: returnToSchema.optional(),
	/** For every member of the organization rather than the person's own. */
	shared: z.boolean().optional(),
});

/** Connected, with the new connection, or the server asks for a sign-in, begun, at the page the browser goes to. */
export const connectMcpSchema = z.discriminatedUnion('kind', [
	z.object({kind: z.literal('connected'), connection: connectionSchema}),
	z.object({kind: z.literal('signIn'), url: z.string()}),
]);

/**
 * `POST connections/<integration>` for one that takes an API key: a new connection, the person's
 * own or every member's, or the one given the key.
 */
export const connectWithKeyBodySchema = z
	.object({
		key: z.string().trim().min(1, 'Paste the API key').max(1000, 'That is too long for an API key'),
		/** The connection to give the key, as its page does; else a new one. */
		connection: z.string().optional(),
	})
	.extend(shareBodySchema.shape);

/**
 * `POST connections/plaid/link-token`: a Link token for a new bank, or, with `connectionId`, for
 * signing in again to the bank of that connection.
 */
export const plaidLinkTokenBodySchema = z.object({connectionId: z.string().min(1).optional()});

export const plaidLinkTokenSchema = z.object({linkToken: z.string()});

/** `POST connections/plaid`: the public token Plaid Link answered with, the person's own bank or every member's. */
export const connectPlaidBodySchema = z
	.object({publicToken: z.string().min(1)})
	.extend(shareBodySchema.shape);
