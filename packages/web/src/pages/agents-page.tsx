import {PlusIcon} from 'lucide-react';
import {Link, useLoaderData, useSearchParams} from 'react-router';
import {findAgentProvider} from '@proxy/integrations';
import {AgentLogo} from '@/components/brand-logo';
import {AppShell, PageTitle} from '@/components/app-shell';
import {EmptyRows, Row, RowHeader, RowList} from '@/components/row-list';
import {ShareToggle} from '@/components/share-toggle';
import {Button} from '@proxy/ui/components/button';
import {useHuman} from '@/hooks/use-human';
import {formatAgo} from '@/lib/format';
import {activeOrgOf, hasOtherPeople} from '@/lib/orgs';
import {cn} from '@proxy/ui/lib/utils';
import type {agentsLoader} from '@/loaders';

// Widths and visibility shared by the header and every row, so the columns line up.
const CELLS = {
	company: 'hidden w-24 shrink-0 truncate text-muted-foreground md:block',
	username: 'hidden w-52 shrink-0 truncate font-mono text-muted-foreground md:block',
	active: 'w-24 shrink-0 text-right text-muted-foreground tabular-nums',
};

// The agent logins in the organization open, newest first: its shared ones and the person's own,
// never another member's. With anyone else in it or invited, a toggle picks the list, in the
// address as `?for=me` or `?for=everyone`, opening on the shared one unless only the person's own
// has any. A revoked one stays listed, muted, until it is deleted.
export function AgentsPage() {
	const {agents: all} = useLoaderData<typeof agentsLoader>();
	const [params, setParams] = useSearchParams();
	const human = useHuman();
	if (!human) {
		return null;
	}

	const activeOrg = activeOrgOf(human);
	const others = hasOtherPeople(activeOrg);
	const sharedCount = all.filter((agent) => agent.shared).length;
	const chosen = params.get('for');
	const showingShared = others && (chosen === 'everyone' || (chosen !== 'me' && sharedCount > 0));
	const agents = others ? all.filter((agent) => agent.shared === showingShared) : all;
	const active = all.filter((agent) => agent.revokedAt === null).length;

	return (
		<AppShell
			title={<PageTitle detail={`${active} active`}>Agents</PageTitle>}
			actions={
				<Button
					size="sm"
					nativeButton={false}
					render={<Link to={showingShared ? '/agents/new?for=everyone' : '/agents/new'} />}
				>
					<PlusIcon data-icon="inline-start" />
					New agent
				</Button>
			}
		>
			{others && (
				<ShareToggle
					orgName={activeOrg.name}
					shared={showingShared}
					counts={{shared: sharedCount, yours: all.length - sharedCount}}
					onChange={(next) => setParams({for: next ? 'everyone' : 'me'}, {replace: true})}
				/>
			)}
			<RowList
				header={
					<RowHeader>
						<span className="size-5 shrink-0" />
						<span className="min-w-0 flex-1">Agent</span>
						<span className={CELLS.company}>Company</span>
						<span className={CELLS.username}>Username</span>
						<span className={CELLS.active}>Last active</span>
					</RowHeader>
				}
			>
				{agents.length === 0 && !others && <EmptyRows>No agents yet.</EmptyRows>}
				{agents.length === 0 && others && showingShared && (
					<EmptyRows>No agent shared with {activeOrg.name} yet.</EmptyRows>
				)}
				{agents.length === 0 && others && !showingShared && (
					<EmptyRows>No agent of your own in {activeOrg.name} yet.</EmptyRows>
				)}
				{agents.map((agent) => {
					const revoked = agent.revokedAt !== null;
					return (
						<Row
							key={agent.id}
							to={`/agents/${agent.id}`}
							icon={<AgentLogo providerId={agent.providerId} />}
							title={
								<span className={cn(revoked && 'text-muted-foreground')}>
									{agent.name}
									{revoked && ' · Revoked'}
								</span>
							}
							cells={
								<>
									<span className={CELLS.company}>
										{findAgentProvider(agent.providerId)?.company ?? agent.providerId}
									</span>
									<span className={CELLS.username}>{agent.username}</span>
									<span className={CELLS.active}>
										{agent.lastActiveAt ? formatAgo(agent.lastActiveAt) : 'Never'}
									</span>
								</>
							}
						/>
					);
				})}
			</RowList>
		</AppShell>
	);
}
