import {PlusIcon} from 'lucide-react';
import {Link, useLoaderData} from 'react-router';
import {findAgentProvider} from '@proxy/integrations';
import {AgentLogo} from '@/components/brand-logo';
import {Badge} from '@proxy/ui/components/badge';
import {AppShell, PageTitle} from '@/components/app-shell';
import {Row, RowHeader, RowList} from '@/components/row-list';
import {SideEmpty, SideToggle} from '@/components/share-toggle';
import {Button} from '@proxy/ui/components/button';
import {useHuman} from '@/hooks/use-human';
import {useSide} from '@/hooks/use-side';
import {formatAgo} from '@/lib/format';
import {cn} from '@proxy/ui/lib/utils';
import type {agentsLoader} from '@/loaders';
import {useOrgSlug} from '@/hooks/use-org';

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
	const org = useOrgSlug();
	const {agents: all} = useLoaderData<typeof agentsLoader>();
	const human = useHuman();
	const side = useSide(all, {opensOnShared: true});
	if (!human) {
		return null;
	}

	const activeOrg = human.org;
	const agents = side.shown;
	const active = all.filter((agent) => agent.revokedAt === null).length;

	return (
		<AppShell
			title={<PageTitle detail={`${active} active`}>Agent permissions</PageTitle>}
			actions={
				<Button
					size="sm"
					nativeButton={false}
					render={
						<Link to={side.shared ? `/${org}/agents/new?for=everyone` : `/${org}/agents/new`} />
					}
				>
					<PlusIcon data-icon="inline-start" />
					New agent
				</Button>
			}
		>
			<SideToggle side={side} orgName={activeOrg.name} />
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
				{agents.length === 0 && (
					<SideEmpty
						side={side}
						alone="No agents yet."
						shared={`No agent shared with ${activeOrg.name} yet.`}
						own={`No agent of your own in ${activeOrg.name} yet.`}
					/>
				)}
				{agents.map((agent) => {
					const revoked = agent.revokedAt !== null;
					return (
						<Row
							key={agent.id}
							to={`/${org}/agents/${agent.id}`}
							icon={<AgentLogo providerId={agent.providerId} />}
							title={
								<span
									className={cn(
										'inline-flex items-center gap-2',
										revoked && 'text-muted-foreground',
									)}
								>
									<span>
										{agent.name}
										{revoked && ' · Revoked'}
									</span>
									{findAgentProvider(agent.providerId)?.connects === 'built-in' && (
										<Badge variant="secondary">Built in</Badge>
									)}
								</span>
							}
							cells={
								<>
									<span className={CELLS.company}>
										{findAgentProvider(agent.providerId)?.company ?? agent.providerId}
									</span>
									{findAgentProvider(agent.providerId)?.connects === 'built-in' ? (
										<span className={cn(CELLS.username, 'font-sans')}>
											The agents on the Chat page
										</span>
									) : (
										<span className={CELLS.username}>{agent.username}</span>
									)}
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
