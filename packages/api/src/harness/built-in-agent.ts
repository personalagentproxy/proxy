import {randomBytes} from 'node:crypto';

import type {Result} from 'ts-results-es';

import {ApiErr, type ApiError, Do, requirePresent} from '@proxy/utils';
import {createAgent, getSignedInAgentByProvider, isProviderConflict, type SignedInAgent} from '@proxy/db/agent';
import {BUILT_IN_AGENT_PROVIDER} from '@proxy/integrations';

/**
 * The organization's built-in agent: an Agent like any other, with grants and an activity log of
 * its own, so the person sets what it may do where they set it for Claude. Made the first time it
 * is needed, with a password nobody knows, since it never signs in: its loop runs in the api.
 */
export function requireBuiltInAgent(orgId: string): Promise<Result<SignedInAgent, ApiError>> {
	return Do(async ($) => {
		const existing = $(await getSignedInAgentByProvider(orgId, BUILT_IN_AGENT_PROVIDER.id));
		if (existing) {
			return existing;
		}
		const created = await createAgent({
			orgId,
			providerId: BUILT_IN_AGENT_PROVIDER.id,
			name: BUILT_IN_AGENT_PROVIDER.name,
			username: `proxy-${randomBytes(6).toString('hex')}`,
			passwordHash: await Bun.password.hash(randomBytes(32).toString('base64url')),
		});
		// Two first chats at once: the other one made it.
		if (created.isErr() && !isProviderConflict(created.error)) {
			return $(created);
		}
		const made = $(await getSignedInAgentByProvider(orgId, BUILT_IN_AGENT_PROVIDER.id));
		return $(requirePresent(made, ApiErr.internalError(new Error('The built-in agent was made and is not there'))));
	});
}
