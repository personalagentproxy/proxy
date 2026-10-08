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
