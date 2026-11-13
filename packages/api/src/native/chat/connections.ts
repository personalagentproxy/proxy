import {Ok, type Result} from 'ts-results-es';

import type {ApiError} from '@proxy/utils';
import {BUILT_IN_AGENT_PROVIDER} from '@proxy/utils/agent-providers';
import {CHAT_BUILT_IN_ACTIONS, CHAT_INTEGRATION_ID} from '@proxy/integrations';
import {createMissingChatConnection} from '@proxy/db/chat';
import type {Viewer} from '@proxy/db/viewer';

/**
 * The Chat connections: one of each member's own, as their vault is, but made the first time it
 * could be used rather than with their membership: once the organization has the built-in agent
 * the Chat page's personas act through, before which there is no thread to read. No agent may do
 * anything with a new one by default, but the built-in agent, which is given everything in its own
 * settings as the connection is made: what was said in a thread may have come from a connection
 * another agent was never given. A shared agent, which is no member's, has none.
 */
export async function ensureChatConnection(viewer: Viewer): Promise<Result<void, ApiError>> {
	const {orgId, userId} = viewer;
	if (userId === null) {
		return Ok(undefined);
	}
	return createMissingChatConnection({
		orgId,
		userId,
		integrationId: CHAT_INTEGRATION_ID,
		providerId: BUILT_IN_AGENT_PROVIDER.id,
		actions: CHAT_BUILT_IN_ACTIONS,
	});
}
