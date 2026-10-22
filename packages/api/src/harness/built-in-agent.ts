import {randomBytes} from 'node:crypto';

import type {Result} from 'ts-results-es';

import type {ApiError} from '@proxy/utils';
import {type AgentRow, createAgent} from '@proxy/db/agent';
import type {Persona} from '@proxy/db/harness';
import type {MemberViewer} from '@proxy/db/viewer';
import {BUILT_IN_AGENT_PROVIDER} from '@proxy/integrations';

/**
 * A new built-in agent of the organization, shared with every member of it, made by the viewer:
 * an Agent like any other, with grants and an activity log of its own, so what it may do on the
 * shared connections is set where it is set for Claude. It has a password nobody knows, since it
 * never signs in: its loop runs in the api, and in each member's conversation it acts as them.
 */
export async function createBuiltInAgent(viewer: MemberViewer, persona: Persona): Promise<Result<AgentRow, ApiError>> {
	return createAgent({
		orgId: viewer.orgId,
		ownerUserId: null,
		createdById: viewer.userId,
		providerId: BUILT_IN_AGENT_PROVIDER.id,
		name: persona.name,
		shape: persona.shape,
		color: persona.color,
		username: `proxy-${randomBytes(6).toString('hex')}`,
		passwordHash: await Bun.password.hash(randomBytes(32).toString('base64url')),
	});
}
