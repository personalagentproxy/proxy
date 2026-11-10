import {useNavigate, useSearchParams} from 'react-router';
import {AddAgent} from '@/components/agent-setup';
import {AppShell, PageTitle} from '@/components/app-shell';
import {SharePicker} from '@/components/share-choice';
import {useLoaded} from '@/hooks/use-loaded';
import {useShareChoice} from '@/hooks/use-share-choice';
import type {agentsLoader} from '@/loaders';
import {useOrgSlug} from '@/hooks/use-org';

// A new agent, added as in the welcome flow, and on to its page. With anyone else in the
// organization or invited, it asks first who the agent is for (`?for=everyone`), until it is made.
export function NewAgentPage() {
	return (
		<AppShell title={<PageTitle>New agent</PageTitle>}>
			<NewAgent />
		</AppShell>
	);
}

function NewAgent() {
	const org = useOrgSlug();
	const {agents} = useLoaded<typeof agentsLoader>();
	const navigate = useNavigate();
	const {shared} = useShareChoice();
	const [params] = useSearchParams();

	return (
		<>
			{!params.has('agent') && (
				<SharePicker
					descriptions={{
						shared:
							'Every member can see it and give it to their own tools; it reaches the connections shared with everyone, never anyone’s own. Whoever makes it and the organization’s owner change its access.',
						own: 'Only you see it. It reaches the connections shared with everyone and your own.',
					}}
				/>
			)}
			<AddAgent
				agents={agents}
				shared={shared}
				continueLabel="Done"
				onContinue={(agent) => navigate(`/${org}/agents/${agent.id}`)}
			/>
		</>
	);
}
