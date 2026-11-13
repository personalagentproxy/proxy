import type {IncomingHttpHeaders} from 'node:http';

import {Err, type Result} from 'ts-results-es';

import {ApiErr, type ApiError, Do, requirePresent} from '@proxy/utils';
import {getSignedInAgentById, type SignedInAgent} from '@proxy/db/agent';
import {getMembership} from '@proxy/db/organization';
import {getSandbox} from '@proxy/db/sandbox';

import {requireOpenTask} from '../agent-side/tasks';
import {isHeldFor} from '../native/sandbox/lease';
import {env} from '../utils/env';
import {verifyCliToken} from './token';

/**
 * Who a request to `/api/cli` is from: code in a sandbox, sending the token its command was given
 * (token.ts) as `Authorization: Bearer <token>`. Every request checks, live, everything the token
 * names: its signature and expiry; the agent, there and not revoked, signed in as the member it
 * acted for when the command was run, who is still in the organization; the task, still under way;
 * and the sandbox, there and still the task's, or a task's above it. So there is nothing to revoke:
 * revoking the agent, finishing the task or the sandbox passing to another task ends the token.
 * Anything wrong is unauthenticated, with words saying how to get a new token, and none saying
 * whose anything else is.
 */

/** Who calls from a sandbox: the agent, the task its command was run for, and the sandbox. */
export type CliCaller = {agent: SignedInAgent; taskId: string; sandboxId: string};

const AGAIN = 'Run the command again with `pap: true` for a new one.';
const NO_TOKEN = 'No token: send `Authorization: Bearer $PAP_TOKEN`, which a sandbox command run with `pap: true` is given.';
const INVALID = `PAP_TOKEN is not a valid token. ${AGAIN}`;
const EXPIRED = `PAP_TOKEN has expired: it lasts as long as the command it was given to. ${AGAIN}`;
const AGENT_GONE = 'The agent PAP_TOKEN was given to is revoked or deleted, so it can do nothing more.';
const TASK_ENDED = 'The task PAP_TOKEN was given for has ended. Start a new task, and run the command for it with `pap: true`.';
const SANDBOX_GONE = `The sandbox PAP_TOKEN was given in is gone, or no longer your task's. ${AGAIN}`;
const MEMBER_GONE = 'The member PAP_TOKEN acts for is no longer in the organization, so it can do nothing more.';

function bearerToken(headers: IncomingHttpHeaders): string | null {
	const header = headers.authorization;
	if (!header?.startsWith('Bearer ')) {
		return null;
	}
	return header.slice('Bearer '.length).trim() || null;
}

// The task's refusal as the token's: one unknown or ended is unauthenticated; the database failing is not.
function taskRefusal(error: ApiError): ApiError {
	if (error.kind === 'not_found' || error.kind === 'conflict') {
		return ApiErr.unauthenticated(TASK_ENDED);
	}
	return error;
}

/**
 * The agent as it was signed in when the command was run. A shared agent acting for a member, as
 * the built-in agent does in a member's chat (@proxy/db/harness getThreadAgent), reaches
 * their own connections beside the shared ones, so it is signed in as them again, while they are
 * still a member; an agent of a member's own is theirs alone, and one that has changed hands since
 * the token was given is refused.
 */
function actingAs(agent: SignedInAgent, member: string | null): Promise<Result<SignedInAgent, ApiError>> {
	return Do(async ($) => {
		if (member === null || agent.ownerUserId === member) {
			return agent;
		}
		if (agent.ownerUserId !== null) {
			return $(Err(ApiErr.unauthenticated(INVALID)));
		}
		$(requirePresent($(await getMembership(member, agent.orgId)), ApiErr.unauthenticated(MEMBER_GONE)));
		return {...agent, ownerUserId: member};
	});
}

/** The caller a request's token names, each part checked now, or unauthenticated, saying what to do. */
export function authenticateCliRequest(headers: IncomingHttpHeaders, now = new Date()): Promise<Result<CliCaller, ApiError>> {
	return Do(async ($) => {
		const token = $(requirePresent(bearerToken(headers), ApiErr.unauthenticated(NO_TOKEN)));
		// Without AUTH_SECRET no token was ever given, so none is valid.
		const secret = $(requirePresent(env.AUTH_SECRET, ApiErr.unauthenticated(INVALID)));
		const verified = verifyCliToken(token, secret, now);
		if (verified.isErr()) {
			return $(Err(ApiErr.unauthenticated(verified.error === 'expired' ? EXPIRED : INVALID)));
		}
		const claims = verified.value;
		const found = $(requirePresent($(await getSignedInAgentById(claims.orgId, claims.agentId)), ApiErr.unauthenticated(AGENT_GONE)));
		const agent = $(await actingAs(found, claims.ownerUserId));
		$((await requireOpenTask(agent, claims.taskId)).mapErr(taskRefusal));
		const sandbox = $(requirePresent($(await getSandbox(claims.connectionId, claims.sandboxId)), ApiErr.unauthenticated(SANDBOX_GONE)));
		if (sandbox.orgId !== agent.orgId || !$(await isHeldFor(sandbox, claims.taskId, now))) {
			return $(Err(ApiErr.unauthenticated(SANDBOX_GONE)));
		}
		return {agent, taskId: claims.taskId, sandboxId: sandbox.id};
	});
}
