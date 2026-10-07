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

/** Turns default actions of a collection on or off; actions left out stay as they are. */
export function setConnectionDefaults(
	connectionId: string,
	collectionId: string,
	actions: Record<string, boolean>,
) {
	return apiRequest(
		'PUT',
		`/api/connections/${connectionId}/defaults/${collectionId}`,
		connectionSchema,
		{actions},
	);
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
