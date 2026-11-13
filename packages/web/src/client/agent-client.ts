import {type agentLoginBodySchema, agentLoginSchema} from '@proxy/contracts/agent-auth';
import {
	agentPageSchema,
	type runScriptBodySchema,
	scriptRunSchema,
} from '@proxy/contracts/agent-side';
import type {z} from 'zod';
import {apiRequest, apiSend} from '@/client/request';

// The agent page: its own sign-in and cookie, and the scripts it sends, run by the api as the MCP
// server's `script` tool is, every call in them checked against the agent's access and logged with
// its task.

/** 401 wrong username or password, 403 a revoked login. */
export function signInAgent(username: string, password: string) {
	return apiRequest('POST', '/agent-auth/login', agentLoginSchema, {
		username,
		password,
	} satisfies z.input<typeof agentLoginBodySchema>);
}

export function signOutAgent() {
	return apiSend('POST', '/agent-auth/logout');
}

/** Who is signed in and what it is told. A 401 means "send it to /agent/login". */
export function getAgentPage() {
	return apiRequest('GET', '/api/agent/me', agentPageSchema);
}

/** Runs a script for `task`, the one an earlier script started: what it came to, in words, and the task for the next. */
export function runAgentScript(body: z.input<typeof runScriptBodySchema>) {
	return apiRequest('POST', '/api/agent/script', scriptRunSchema, body);
}
