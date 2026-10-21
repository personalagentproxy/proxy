import {AGENT_PROVIDERS} from '@proxy/integrations';
import {useLoaderData, useNavigate} from 'react-router';
import {AgentSetup} from '@/components/agent-setup';
import {AppShell, PageTitle} from '@/components/app-shell';
import {BackButton} from '@/components/back-button';
import {SharePicker} from '@/components/share-choice';
import {useShareChoice} from '@/lib/share-choice';
import type {agentsLoader} from '@/loaders';

// A new agent, set up as in the welcome flow: chosen from the companies without a login yet, or a
// custom MCP agent, then handed its login or added as a connector, and on to its page. With anyone
// else in the organization or invited, it asks first who the agent is for (`?for=everyone`): the
// companies without a login are those without one of that kind.
export function NewAgentPage() {
	const {agents} = useLoaderData<typeof agentsLoader>();
	const navigate = useNavigate();
	const {shared} = useShareChoice();
	const providers = AGENT_PROVIDERS.filter(
		(provider) =>
			provider.custom ||
			!agents.some((agent) => agent.providerId === provider.id && agent.shared === shared),
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
			<SharePicker
				descriptions={{
					shared:
						'Every member can see it and give it to their own tools; it reaches the connections shared with everyone, never anyone’s own. Whoever makes it and the organization’s owner change its access.',
					own: 'Only you see it. It reaches the connections shared with everyone and your own.',
				}}
			/>
			<AgentSetup
				agents={agents.filter((agent) => agent.shared === shared)}
				providers={providers}
				shared={shared}
				continueLabel="Done"
				onContinue={(agent) => navigate(agent ? `/agents/${agent.id}` : '/agents')}
			/>
		</AppShell>
	);
}
