import type {Result} from 'ts-results-es';

import {type ApiError, Do} from '@proxy/utils';
import type {ThreadRow} from '@proxy/db/harness';

import {getBuiltInAgent} from './built-in-agent';
import type {HarnessStore} from './store';

/**
 * The member's chat with the persona, begun the first time, through the organization's built-in
 * login: as the page begins it (route.ts), and as a message from Slack does (slack/messages.ts).
 */
export function ensureChat(store: Pick<HarnessStore, 'getMemberChat' | 'ensureMemberChat'>, member: {orgId: string; userId: string}, persona: {id: string}): Promise<Result<ThreadRow, ApiError>> {
	return Do(async ($) => {
		const existing = $(await store.getMemberChat(persona.id, member.userId));
		if (existing) {
			return existing;
		}
		const login = $(await getBuiltInAgent(member.orgId));
		return $(await store.ensureMemberChat({orgId: member.orgId, agentId: login.id, personaId: persona.id, userId: member.userId}));
	});
}
