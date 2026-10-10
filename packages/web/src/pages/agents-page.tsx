import {PlusIcon} from 'lucide-react';
import {Link, useLoaderData} from 'react-router';
import {AGENT_PROVIDERS, findAgentProvider} from '@proxy/integrations';
import {AgentLogo} from '@/components/brand-logo';
import {AppShell, PageTitle} from '@/components/app-shell';
import {EmptyRows, Row, RowHeader, RowList} from '@/components/row-list';
import {Button} from '@proxy/ui/components/button';
import {formatAgo} from '@/lib/format';
import {cn} from '@proxy/ui/lib/utils';
import type {agentsLoader} from '@/loaders';

// Widths and visibility shared by the header and every row, so the columns line up.
const CELLS = {
	company: 'hidden w-24 shrink-0 truncate text-muted-foreground md:block',
	username: 'hidden w-52 shrink-0 truncate font-mono text-muted-foreground md:block',
	active: 'w-24 shrink-0 text-right text-muted-foreground tabular-nums',
};

// Every agent login, newest first. A revoked one stays listed, muted, until it is deleted.
export function AgentsPage() {
	const {agents} = useLoaderData<typeof agentsLoader>();
	const active = agents.filter((agent) => agent.revokedAt === null).length;
	const availableProviders = AGENT_PROVIDERS.filter(
		(provider) => !agents.some((agent) => agent.providerId === provider.id),
	);

	return (
		<AppShell
			title={<PageTitle detail={`${active} active`}>Agents</PageTitle>}
			actions={
				availableProviders.length === 0 ? (
					<Button size="sm" disabled>
						<PlusIcon data-icon="inline-start" />
						All agents added
					</Button>
				) : (
					<Button size="sm" nativeButton={false} render={<Link to="/agents/new" />}>
						<PlusIcon data-icon="inline-start" />
						New agent
					</Button>
				)
			}
		>
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
				{agents.length === 0 && <EmptyRows>No agents yet.</EmptyRows>}
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
