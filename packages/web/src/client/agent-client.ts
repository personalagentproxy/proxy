import {z} from 'zod';
import {dataRecordSchema} from '@/client/schemas';
import {apiRequest, apiSend} from '@/client/request';

// The agent side: its own sign-in and cookie. Every records call is checked against the agent's
// access and logged by the api, a refused one (403) too.

const agentMeSchema = z.object({
	agent: z.object({id: z.string(), providerId: z.string(), name: z.string()}),
	connections: z.array(
		z.object({
			id: z.string(),
			integrationId: z.string(),
			account: z.string(),
			// The actions the agent can take with the connection.
			actions: z.array(z.string()),
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

// Everything an agent does with a connection is one of its tools, generated from the catalog
// (`toolName` in @proxy/integrations): the page asks for a list or a record and gets one back.
function toolPath(connectionId: string, tool: string): string {
	return `/api/agent/connections/${connectionId}/tools/${tool}`;
}

/**
 * Runs a list tool: a page of records, newest first, and the token of the next, older page. A list
 * opened inside a record says where it is: that record last, those above it before it.
 */
export function runAgentListTool(
	connectionId: string,
	tool: string,
	params: Record<string, string>,
) {
	return apiRequest(
		'POST',
		toolPath(connectionId, tool),
		z.object({
			records: z.array(dataRecordSchema),
			nextPage: z.string().nullable(),
			trail: z.array(z.object({id: z.string(), title: z.string()})).optional(),
		}),
		{params},
	);
}

/**
 * Runs any other tool, such as opening a record, saving a draft or Archive: the record after, or
 * null once it has left the collection.
 */
export function runAgentRecordTool(
	connectionId: string,
	tool: string,
	params: Record<string, string>,
) {
	return apiRequest(
		'POST',
		toolPath(connectionId, tool),
		z.object({record: dataRecordSchema.nullable()}),
		{
			params,
		},
	);
}
