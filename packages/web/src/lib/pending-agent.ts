import {Result} from 'ts-results-es';
import {z} from 'zod';

// The agent being set up as an MCP client's login, so the sign-in page the client opens in this
// browser has it chosen already. Kept for an hour, after which a setup left open is forgotten.
const KEY = 'proxy.pending-agent';
const KEPT_MS = 60 * 60 * 1000;

const pendingSchema = z.object({org: z.string(), agentId: z.string(), at: z.number()});

export type PendingAgent = {org: string; agentId: string};

export function rememberPendingAgent(pending: PendingAgent) {
	localStorage.setItem(KEY, JSON.stringify({...pending, at: Date.now()}));
}

/** Forgets the agent, once it has signed in; another being set up stays. */
export function forgetPendingAgent(agentId: string) {
	if (pendingAgent()?.agentId !== agentId) {
		return;
	}
	localStorage.removeItem(KEY);
}

export function pendingAgent(): PendingAgent | null {
	const stored = localStorage.getItem(KEY);
	if (!stored) {
		return null;
	}
	const parsed = Result.wrap(() => pendingSchema.safeParse(JSON.parse(stored)));
	if (parsed.isErr() || !parsed.value.success) {
		return null;
	}
	const {org, agentId, at} = parsed.value.data;
	if (Date.now() - at > KEPT_MS) {
		return null;
	}
	return {org, agentId};
}
