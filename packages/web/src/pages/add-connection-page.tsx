import {useNavigate} from 'react-router';
import {AppShell, PageTitle} from '@/components/app-shell';
import {BackButton} from '@/components/back-button';
import {IntegrationLogo} from '@/components/integration-logo';
import {useStore} from '@/components/mock-store';
import {RowList} from '@/components/row-list';
import {Button} from '@/components/ui/button';
import {INTEGRATIONS} from '@/lib/integrations';

// The catalog. Connect stands in for the provider's own sign-in: the mock connects the sample
// account at once, with the provider's sample records.
export function AddConnectionPage() {
	const navigate = useNavigate();
	const {state, connect} = useStore();
	const available = INTEGRATIONS.filter((integration) => !integration.builtIn);

	return (
		<AppShell
			title={
				<>
					<BackButton to="/connections" label="Back to connections" />
					<PageTitle>Add connection</PageTitle>
				</>
			}
		>
			<RowList>
				{available.map((integration) => {
					const existing = state.connections.find(
						(connection) => connection.integrationId === integration.id,
					);
					return (
						<li
							key={integration.id}
							className="flex min-h-14 items-center gap-3 px-4 py-2 text-sm md:px-3"
						>
							<IntegrationLogo integration={integration} className="size-7" />
							<div className="grid min-w-0 flex-1">
								<span className="truncate">{integration.name}</span>
								<span className="truncate text-xs text-muted-foreground">
									{integration.description}
								</span>
							</div>
							{existing ? (
								<Button
									size="sm"
									variant="ghost"
									onClick={() => navigate(`/connections/${existing.id}`)}
								>
									Connected
								</Button>
							) : (
								<Button
									size="sm"
									variant="outline"
									onClick={() => navigate(`/connections/${connect(integration.id)}`)}
								>
									Connect
								</Button>
							)}
						</li>
					);
				})}
			</RowList>
		</AppShell>
	);
}
