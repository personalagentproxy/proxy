import {AGENT_PROVIDERS} from '@proxy/integrations';
import {useLoaderData, useNavigate} from 'react-router';
import {AgentSetup} from '@/components/agent-setup';
import {AppShell, PageTitle} from '@/components/app-shell';
import {BackButton} from '@/components/back-button';
import type {agentsLoader} from '@/loaders';

// A new agent, set up as in the welcome flow: chosen from the companies without a login yet, then
// handed its login or added as a connector, and on to its page.
export function NewAgentPage() {
	const {agents} = useLoaderData<typeof agentsLoader>();
	const navigate = useNavigate();
	const providers = AGENT_PROVIDERS.filter(
		(provider) => !agents.some((agent) => agent.providerId === provider.id),
	);

	return (
		<AppShell
			title={
				<>
					<BackButton to="/agents" label="Back to agents" />
					<PageTitle>New agent</PageTitle>
				</>
			}
		>
			<div className="grid gap-4 md:px-3">
				<AgentSetup
					agents={agents}
					providers={providers}
					continueLabel="Done"
					onContinue={(agent) => navigate(agent ? `/agents/${agent.id}` : '/agents')}
				/>
			</div>
		</AppShell>
	);
}
