import {AGENT_PROVIDERS} from '@proxy/integrations';
import {useLoaderData, useNavigate} from 'react-router';
import {AgentSetup} from '@/components/agent-setup';
import {AppShell, PageTitle} from '@/components/app-shell';
import {BackButton} from '@/components/back-button';
import {SharePicker} from '@/components/share-choice';
import {useShareChoice} from '@/lib/share-choice';
import type {agentsLoader} from '@/loaders';
import {useOrgSlug} from '@/hooks/use-org';

// A new agent, set up as in the welcome flow: chosen from the companies, any of which can have
// any number of logins, or a custom MCP agent, then handed its login or added as a connector, and
// on to its page. With anyone else in the organization or invited, it asks first who the agent is
// for (`?for=everyone`).
export function NewAgentPage() {
	const org = useOrgSlug();
	const {agents} = useLoaderData<typeof agentsLoader>();
	const navigate = useNavigate();
	const {shared} = useShareChoice();

	return (
		<AppShell
			title={
				<>
					<BackButton to={`/${org}/agents`} label="Back to agents" />
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
				providers={AGENT_PROVIDERS}
				shared={shared}
				continueLabel="Done"
				onContinue={(agent) => navigate(agent ? `/${org}/agents/${agent.id}` : `/${org}/agents`)}
			/>
		</AppShell>
	);
}
