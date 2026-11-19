import {randomBytes} from 'node:crypto';

import type {Result} from 'ts-results-es';

import {ApiErr, type ApiError, Do, requirePresent} from '@proxy/utils';
import {type AgentRow, getSharedAgent} from '@proxy/db/agent';
import type {NewBuiltInAgent} from '@proxy/db/organization';
import {BUILT_IN_AGENT_PROVIDER} from '@proxy/utils/agent-providers';

import {unknownPasswordHash} from '../agents/unknown-password';

/**
 * The login of an organization's one built-in agent, which every persona of the Chat page acts
 * through, named Chat for that: an Agent like any other, shared with every member, with grants and
 * an activity log of its own, so what the personas may do on the shared connections is set where
 * it is set for Claude. Made with the organization (orgs/provision.ts), by nobody in particular,
 * so only the organization's owner changes its grants. It has a password nobody knows, since it
 * never signs in: its loop runs in the api, and in each member's chat it acts as them.
 */
export async function newBuiltInAgent(): Promise<NewBuiltInAgent> {
	return {name: 'Chat', username: `proxy-${randomBytes(6).toString('hex')}`, passwordHash: await unknownPasswordHash()};
}

/** The organization's built-in agent, which every organization has from the start. */
export function getBuiltInAgent(orgId: string): Promise<Result<AgentRow, ApiError>> {
	return Do(async ($) => {
		const agent = $(await getSharedAgent(orgId, BUILT_IN_AGENT_PROVIDER.id));
		return $(requirePresent(agent, ApiErr.internalError(new Error(`Organization ${orgId} has no built-in agent`))));
	});
}
