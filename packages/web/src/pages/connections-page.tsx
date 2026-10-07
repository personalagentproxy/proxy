import {PlusIcon} from 'lucide-react';
import {Link} from 'react-router';
import {AppShell, PageTitle} from '@/components/app-shell';
import {IntegrationLogo} from '@/components/integration-logo';
import {useStore} from '@/components/mock-store';
import {EmptyRows, Row, RowHeader, RowList} from '@/components/row-list';
import {Button} from '@/components/ui/button';
import {agentsWithAccess, integrationOf} from '@/lib/access';

// Widths and visibility shared by the header and every row, so the columns line up.
const CELLS = {
	account: 'hidden w-48 shrink-0 truncate text-right text-muted-foreground md:block',
	agents: 'w-20 shrink-0 text-right text-muted-foreground tabular-nums',
};

// The services connected to Proxy. Information is kept on a page of its own.
export function ConnectionsPage() {
	const {state} = useStore();
	const connections = state.connections.filter((connection) => !integrationOf(connection).builtIn);

	return (
		<AppShell
			title={<PageTitle detail={`${connections.length} connected`}>Connections</PageTitle>}
			actions={
				<Button size="sm" nativeButton={false} render={<Link to="/connections/new" />}>
					<PlusIcon data-icon="inline-start" />
					Add connection
				</Button>
			}
		>
			<RowList
				header={
					<RowHeader>
						<span className="size-5 shrink-0" />
						<span className="min-w-0 flex-1">Service</span>
						<span className={CELLS.account}>Account</span>
						<span className={CELLS.agents}>Agents</span>
					</RowHeader>
				}
			>
				{connections.length === 0 && <EmptyRows>Nothing connected yet.</EmptyRows>}
				{connections.map((connection) => {
					const integration = integrationOf(connection);
					return (
						<Row
							key={connection.id}
							to={`/connections/${connection.id}`}
							icon={<IntegrationLogo integration={integration} />}
							title={integration.name}
							cells={
								<>
									<span className={CELLS.account}>{connection.account}</span>
									<span className={CELLS.agents}>
										{agentsWithAccess(state, connection.id).length}
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
