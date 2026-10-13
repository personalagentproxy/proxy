import type {EmailProvider, MailServers} from '@proxy/integrations';
import {z} from 'zod';
import {connectionSchema} from '@/client/schemas';
import {apiRequest, apiSend} from '@/client/request';

export function listConnections() {
	return apiRequest('GET', '/api/connections', z.object({connections: z.array(connectionSchema)}));
}

export function getConnection(connectionId: string) {
	return apiRequest('GET', `/api/connections/${connectionId}`, connectionSchema);
}

export function deleteConnection(connectionId: string) {
	return apiSend('DELETE', `/api/connections/${connectionId}`);
}

/** Turns default actions of a connection on or off; actions left out stay as they are. */
export function setConnectionDefaults(connectionId: string, actions: Record<string, boolean>) {
	return apiRequest('PUT', `/api/connections/${connectionId}/defaults`, connectionSchema, {
		actions,
	});
}

export type ConnectEmailInput = {
	provider: EmailProvider['id'];
	email: string;
	password: string;
	servers?: MailServers;
};

/** Signs in to the mailbox first: 422 is a wrong password, 502 a server out of reach. */
export function connectEmail(input: ConnectEmailInput) {
	return apiRequest('POST', '/api/connections/email', connectionSchema, input);
}

/** Signs in to the mailbox and saves nothing: the Test connection button. Answers 204, or the same errors as connecting. */
export function testEmail(input: ConnectEmailInput) {
	return apiSend('POST', '/api/connections/email/test', input);
}

export type DatabaseDialect = 'postgres' | 'mysql';

export type ConnectDatabaseInput = {
	host: string;
	port: number;
	database: string;
	username: string;
	password: string;
	tls: 'verify' | 'require' | 'off';
};

/** Signs in to the database first: 422 is a wrong password, 502 a server out of reach, 400 says what is wrong with the host. */
export function connectDatabase(dialect: DatabaseDialect, input: ConnectDatabaseInput) {
	return apiRequest('POST', `/api/connections/${dialect}`, connectionSchema, input);
}

/** Signs in to the database and saves nothing: the Test connection button. Answers 204, or the same errors as connecting. */
export function testDatabase(dialect: DatabaseDialect, input: ConnectDatabaseInput) {
	return apiSend('POST', `/api/connections/${dialect}/test`, input);
}

export type ConnectMcpInput = {name: string; url: string; token?: string; returnTo?: 'welcome'};

/**
 * Connects a custom MCP server by its address, with a token where the server takes one: the new
 * connection, or that the server asks for a sign-in, begun, with the server's sign-in page for the
 * browser to go to; it comes back to the new connection, or to the welcome flow's page for it
 * (`returnTo`). A 400 says what is wrong with the address, 422 that the token was turned down, 502
 * that the server could not be reached.
 */
export function connectMcp(input: ConnectMcpInput) {
	return apiRequest(
		'POST',
		'/api/connections/mcp',
		z.discriminatedUnion('kind', [
			z.object({kind: z.literal('connected'), connection: connectionSchema}),
			z.object({kind: z.literal('signIn'), url: z.string()}),
		]),
		input,
	);
}

/** Asks a custom MCP server for its tools again and keeps the new list. */
export function refreshMcpTools(connectionId: string) {
	return apiRequest('POST', `/api/connections/${connectionId}/tools`, connectionSchema);
}
