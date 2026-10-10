import {AGENT_PROVIDERS, findAgentProvider} from '@proxy/integrations';
import {useLoaderData, useNavigate} from 'react-router';
import {AgentSetup} from '@/components/agent-setup';
import {AppShell, PageTitle} from '@/components/app-shell';
import {BackButton} from '@/components/back-button';
import {NotFound} from '@/components/not-found';
import type {agentSetupLoader} from '@/loaders';

// One agent set up again, as when it was added: a new password handed over the way it takes one,
// or the connector added again.
export function AgentSetupPage() {
	const {agent, agents} = useLoaderData<typeof agentSetupLoader>();
	const navigate = useNavigate();
	const provider = agent && findAgentProvider(agent.providerId);
	if (!agent || !provider) {
		return <NotFound what="agent" back="/agents" backLabel="Back to agents" />;
	}

	return (
		<AppShell
			title={
				<>
					<BackButton to={`/agents/${agent.id}`} label={`Back to ${agent.name}`} />
					<PageTitle>Set up {agent.name}</PageTitle>
				</>
			}
		>
			<div className="grid gap-4 md:px-3">
				{agent.revokedAt === null ? (
					<AgentSetup
						agents={agents}
						providers={AGENT_PROVIDERS}
						fixed={provider.id}
						continueLabel="Done"
						onContinue={() => navigate(`/agents/${agent.id}`)}
					/>
				) : (
					<p className="text-sm text-muted-foreground">
						This login is revoked. Restore it on its page to set it up again.
					</p>
				)}
			</div>
		</AppShell>
	);
}
