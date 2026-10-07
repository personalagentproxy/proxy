import {z} from 'zod';
import {AGENT_PROVIDER_IDS} from '@proxy/agent-providers';
import {accessSchema, dataRecordSchema} from '@/client/schemas';
import {apiRequest, apiSend} from '@/client/request';

// The agent side: its own sign-in and cookie. Every records call is checked against the agent's
// access and logged by the api, a refused one (403) too.

const agentMeSchema = z.object({
	agent: z.object({
		id: z.string(),
		providerId: z.enum(AGENT_PROVIDER_IDS).nullable(),
		name: z.string(),
	}),
	connections: z.array(
		z.object({
			id: z.string(),
			integrationId: z.string(),
			account: z.string(),
			collections: z.array(z.object({id: z.string(), access: accessSchema})),
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

export type ListQuery = {search: string | null; page: string | null};

/** A page of records, newest first; `nextPage` asks for the older ones after it. */
export function listAgentRecords(connectionId: string, collectionId: string, query: ListQuery) {
	const params = new URLSearchParams();
	if (query.search) {
		params.set('search', query.search);
	}
	if (query.page) {
		params.set('page', query.page);
	}
	const suffix = params.size > 0 ? `?${params}` : '';
	return apiRequest(
		'GET',
		`${recordsPath(connectionId, collectionId)}${suffix}`,
		z.object({
			access: accessSchema,
			records: z.array(dataRecordSchema),
			nextPage: z.string().nullable(),
		}),
	);
}

export function getAgentRecord(connectionId: string, collectionId: string, recordId: string) {
	return apiRequest(
		'GET',
		`${recordsPath(connectionId, collectionId)}/${recordId}`,
		z.object({access: accessSchema, record: dataRecordSchema}),
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
