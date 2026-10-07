import type {AgentProviderId} from '@/lib/agent-providers';
import type {AgentLogin} from '@/lib/types';

export type AddAgentResult = {
	agents: AgentLogin[];
	agent: AgentLogin;
	created: boolean;
};

// Keeps the one-login-per-provider invariant in one pure, testable operation. The caller owns
// the new login's credentials because generating them is a browser-side concern in the mock.
export function addAgent(
	agents: AgentLogin[],
	providerId: AgentProviderId,
	create: (providerId: AgentProviderId) => AgentLogin,
): AddAgentResult {
	const existing = agents.find((agent) => agent.providerId === providerId);
	if (existing) {
		return {agents, agent: existing, created: false};
	}

	const agent = create(providerId);
	return {agents: [agent, ...agents], agent, created: true};
}
