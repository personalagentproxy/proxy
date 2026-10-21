import type {Prisma} from '@prisma/client';

import {type Experiment, organizationExperiments} from '@proxy/utils';

// An agent signed in with its cookie (agent.ts) or an MCP client's token (oauth.ts), read the same
// way by both. A module of its own, so tests that mock either of them still get it.

export type SignedInAgent = {
	agentId: string;
	orgId: string;
	// The member whose own the agent is, whose connections it reaches beside the shared ones; null
	// for a shared agent, which reaches the shared ones alone.
	ownerUserId: string | null;
	providerId: string;
	name: string;
	/** The experiments on for the agent's organization. */
	experiments: Experiment[];
};

/** What a signed-in agent is read from, with a cookie or an MCP client's token. */
export const signedInAgentSelect = {
	id: true,
	orgId: true,
	ownerUserId: true,
	providerId: true,
	name: true,
	revokedAt: true,
	org: {select: {insider: true, experiments: true}},
} satisfies Prisma.AgentSelect;

/** `null` for a revoked agent. */
export function toSignedInAgent(
	agent: Prisma.AgentGetPayload<{select: typeof signedInAgentSelect}>,
): SignedInAgent | null {
	if (agent.revokedAt !== null) {
		return null;
	}
	return {
		agentId: agent.id,
		orgId: agent.orgId,
		ownerUserId: agent.ownerUserId,
		providerId: agent.providerId,
		name: agent.name,
		experiments: organizationExperiments(agent.org),
	};
}
