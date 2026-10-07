import {z} from 'zod';
import {dataRecordSchema} from '@/client/schemas';
import {apiRequest, apiSend} from '@/client/request';

// The agent side: its own sign-in and cookie. Every records call is checked against the agent's
// access and logged by the api, a refused one (403) too.

const agentMeSchema = z.object({
	agent: z.object({id: z.string(), name: z.string()}),
	connections: z.array(
		z.object({
			id: z.string(),
			integrationId: z.string(),
			account: z.string(),
			// The actions the agent can take in each collection it can read.
			collections: z.array(z.object({id: z.string(), actions: z.array(z.string())})),
		}),
	),
});

export type AgentMe = z.infer<typeof agentMeSchema>;

/** 401 wrong username or password, 403 a revoked login. */
export function signInAgent(username: string, password: string) {
	return apiRequest('POST', '/agent-auth/login', z.object({agentId: z.string()}), {
		username,
		password,
	});
}

export function signOutAgent() {
	return apiSend('POST', '/agent-auth/logout');
}

/** Who is signed in and everything it can reach. A 401 means "send it to /agent/login". */
export function getAgentMe() {
	return apiRequest('GET', '/api/agent/me', agentMeSchema);
}

function recordsPath(connectionId: string, collectionId: string): string {
	return `/api/agent/connections/${connectionId}/collections/${collectionId}/records`;
}

export function listAgentRecords(connectionId: string, collectionId: string) {
	return apiRequest(
		'GET',
		recordsPath(connectionId, collectionId),
		z.object({actions: z.array(z.string()), records: z.array(dataRecordSchema)}),
	);
}

export function getAgentRecord(connectionId: string, collectionId: string, recordId: string) {
	return apiRequest(
		'GET',
		`${recordsPath(connectionId, collectionId)}/${recordId}`,
		z.object({actions: z.array(z.string()), record: dataRecordSchema}),
	);
}

export function createAgentRecord(
	connectionId: string,
	collectionId: string,
	values: Record<string, string>,
) {
	return apiRequest('POST', recordsPath(connectionId, collectionId), dataRecordSchema, {values});
}

export function updateAgentRecord(
	connectionId: string,
	collectionId: string,
	recordId: string,
	values: Record<string, string>,
) {
	return apiRequest(
		'PUT',
		`${recordsPath(connectionId, collectionId)}/${recordId}`,
		dataRecordSchema,
		{values},
	);
}

export function deleteAgentRecord(connectionId: string, collectionId: string, recordId: string) {
	return apiSend('DELETE', `${recordsPath(connectionId, collectionId)}/${recordId}`);
}

/** Runs a command such as Archive or Send: the record after, or null once it left the collection. */
export function runAgentCommand(
	connectionId: string,
	collectionId: string,
	recordId: string,
	commandId: string,
) {
	return apiRequest(
		'POST',
		`${recordsPath(connectionId, collectionId)}/${recordId}/commands/${commandId}`,
		z.object({record: dataRecordSchema.nullable()}),
	);
}
