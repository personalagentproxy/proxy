import {
	type connectDatabaseBodySchema,
	type connectEmailBodySchema,
	connectionListSchema,
	connectionSchema,
	type connectMcpBodySchema,
	connectMcpSchema,
	type connectPlaidBodySchema,
	type connectWithKeyBodySchema,
	type plaidLinkTokenBodySchema,
	plaidLinkTokenSchema,
	type renameConnectionBodySchema,
	type setDefaultsBodySchema,
} from '@proxy/contracts/connections';
import type {IntegrationId} from '@proxy/integrations';
import type {z} from 'zod';
import {apiRequest, apiSend, orgApi} from '@/client/request';

// Every call is about one organization, by its slug (`org`), as its address in the app names it.

/** The connections the person sees in the organization: its shared ones and their own. */
export function listConnections(org: string) {
	return apiRequest('GET', `${orgApi(org)}/connections`, connectionListSchema);
}

/** Shares one's own connection with every member of its organization, for good. */
export function shareConnection(org: string, connectionId: string) {
	return apiRequest('POST', `${orgApi(org)}/connections/${connectionId}/share`, connectionSchema);
}

export function getConnection(org: string, connectionId: string) {
	return apiRequest('GET', `${orgApi(org)}/connections/${connectionId}`, connectionSchema);
}

export function deleteConnection(org: string, connectionId: string) {
	return apiSend('DELETE', `${orgApi(org)}/connections/${connectionId}`);
}

/** Renames a connection; an empty name is none of its own, so it shows as its integration again. */
export function renameConnection(org: string, connectionId: string, name: string) {
	return apiRequest('PUT', `${orgApi(org)}/connections/${connectionId}/name`, connectionSchema, {
		name,
	} satisfies z.input<typeof renameConnectionBodySchema>);
}

/** Turns default actions of a connection on or off; actions left out stay as they are. */
export function setConnectionDefaults(
	org: string,
	connectionId: string,
	actions: Record<string, boolean>,
) {
	return apiRequest(
		'PUT',
		`${orgApi(org)}/connections/${connectionId}/defaults`,
		connectionSchema,
		{actions} satisfies z.input<typeof setDefaultsBodySchema>,
	);
}

// `shared`: for every member of the organization rather than the person's own.
export type ConnectEmailInput = z.input<typeof connectEmailBodySchema>;

/** Signs in to the mailbox first: 422 is a wrong password, 502 a server out of reach. */
export function connectEmail(org: string, input: ConnectEmailInput) {
	return apiRequest('POST', `${orgApi(org)}/connections/email`, connectionSchema, input);
}

/** Signs in to the mailbox and saves nothing: the Test connection button. Answers 204, or the same errors as connecting. */
export function testEmail(org: string, input: ConnectEmailInput) {
	return apiSend('POST', `${orgApi(org)}/connections/email/test`, input);
}

/** A database's integration, one connected on the database form (`form: 'database'` in the catalog): Postgres, MySQL. */
export type DatabaseDialect = IntegrationId;

export type ConnectDatabaseInput = z.input<typeof connectDatabaseBodySchema>;

/** Signs in to the database first: 422 is a wrong password, 502 a server out of reach, 400 says what is wrong with the host. */
export function connectDatabase(
	org: string,
	dialect: DatabaseDialect,
	input: ConnectDatabaseInput,
) {
	return apiRequest('POST', `${orgApi(org)}/connections/${dialect}`, connectionSchema, input);
}

/** Signs in to the database and saves nothing: the Test connection button. Answers 204, or the same errors as connecting. */
export function testDatabase(org: string, dialect: DatabaseDialect, input: ConnectDatabaseInput) {
	return apiSend('POST', `${orgApi(org)}/connections/${dialect}/test`, input);
}

/**
 * Connects a custom MCP server by its address, with a token where the server takes one: the new
 * connection, or that the server asks for a sign-in, begun, with the server's sign-in page for the
 * browser to go to; it comes back to the new connection, or to the welcome flow's page for it
 * (`returnTo`). A 400 says what is wrong with the address, 422 that the token was turned down, 502
 * that the server could not be reached.
 */
export function connectMcp(org: string, input: z.input<typeof connectMcpBodySchema>) {
	return apiRequest('POST', `${orgApi(org)}/connections/mcp`, connectMcpSchema, input);
}

/**
 * Connects an integration that takes an API key, Cloudflare, Exa, Keenable, Linear or Parallel,
 * with one, checked with the service first: a new connection, or, with `connection`, that
 * connection given the key, its name kept. 422 is a key the service turned down, 502 the service
 * out of reach, 400 says what is wrong with the key.
 */
export function connectWithKey(
	org: string,
	integrationId: IntegrationId,
	input: z.input<typeof connectWithKeyBodySchema>,
) {
	return apiRequest('POST', `${orgApi(org)}/connections/${integrationId}`, connectionSchema, input);
}

/** Asks a custom MCP server for its tools again and keeps the new list. */
export function refreshMcpTools(org: string, connectionId: string) {
	return apiRequest('POST', `${orgApi(org)}/connections/${connectionId}/tools`, connectionSchema);
}

/**
 * A Link token for Plaid Link: a new bank, or, with `connectionId`, signing in again to the bank of
 * that connection. A 400 says Plaid isn't set up on the server, or what Plaid refused.
 */
export function createPlaidLinkToken(org: string, connectionId?: string) {
	return apiRequest(
		'POST',
		`${orgApi(org)}/connections/plaid/link-token`,
		plaidLinkTokenSchema,
		(connectionId === undefined ? {} : {connectionId}) satisfies z.input<
			typeof plaidLinkTokenBodySchema
		>,
	);
}

/** Connects the bank Plaid Link signed in to, by the public token it answered with, the person's own or every member's. */
export function connectPlaid(org: string, publicToken: string, shared = false) {
	return apiRequest('POST', `${orgApi(org)}/connections/plaid`, connectionSchema, {
		publicToken,
		...(shared ? {shared} : {}),
	} satisfies z.input<typeof connectPlaidBodySchema>);
}
