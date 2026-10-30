import {randomBytes} from 'node:crypto';

import type {Result} from 'ts-results-es';

import type {ApiError} from '@proxy/utils';
import {type AgentRow, ensureSharedAgent} from '@proxy/db/agent';
import {BUILT_IN_AGENT_PROVIDER} from '@proxy/utils/agent-providers';

/**
 * The organization's one built-in agent login, which every persona of the Chat page acts through,
 * named Chat for that: an Agent like any other, shared with every member, with grants and an
 * activity log of its own, so what the personas may do on the shared connections is set where it
 * is set for Claude. Made the first time Chat is used, once however many open it at once, by
 * nobody in particular, so only the organization's owner changes its grants. It has a password
 * nobody knows, since it never signs in: its loop runs in the api, and in each member's
 * conversation it acts as them.
 */
export function ensureBuiltInAgent(orgId: string): Promise<Result<AgentRow, ApiError>> {
	return ensureSharedAgent(orgId, BUILT_IN_AGENT_PROVIDER.id, async () => ({
		name: 'Chat',
		username: `proxy-${randomBytes(6).toString('hex')}`,
		passwordHash: await Bun.password.hash(randomBytes(32).toString('base64url')),
	}));
}
