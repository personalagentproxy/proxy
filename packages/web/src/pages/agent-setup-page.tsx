import {useLoaderData, useNavigate} from 'react-router';
import {AgentSetup} from '@/components/agent-setup';
import {AppShell, PageTitle} from '@/components/app-shell';
import {NotFound} from '@/components/not-found';
import type {agentSetupLoader} from '@/loaders';
import {useOrgSlug} from '@/hooks/use-org';

// One agent set up again, as when it was added: a new password handed over the way it takes one,
// or the connector added again.
export function AgentSetupPage() {
	const org = useOrgSlug();
	const {agent} = useLoaderData<typeof agentSetupLoader>();
	const navigate = useNavigate();
	if (!agent) {
		return <NotFound what="agent" />;
	}

	return (
		<AppShell title={<PageTitle>Set up {agent.name}</PageTitle>}>
			{agent.revokedAt === null ? (
				<AgentSetup
					agent={agent}
					continueLabel="Done"
					onContinue={() => navigate(`/${org}/agents/${agent.id}`)}
				/>
			) : (
				<p className="text-sm text-muted-foreground">
					This login is revoked. Restore it on its page to set it up again.
				</p>
			)}
		</AppShell>
	);
}
