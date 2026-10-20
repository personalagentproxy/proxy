import {useLoaderData, useNavigate, useSearchParams} from 'react-router';
import {AppShell, PageTitle} from '@/components/app-shell';
import {BackButton} from '@/components/back-button';
import {IntegrationCatalog, SignInFailed} from '@/components/integration-catalog';
import {useExperiments} from '@/hooks/use-experiment';
import type {addConnectionLoader} from '@/loaders';

// The catalog: a plus per integration, with how many accounts of it are connected. A mailbox, a
// database or a custom MCP server goes to its form; a sign-in starts at the api; an API key is
// taken in a dialog here. Each lands on the new connection's page.
export function AddConnectionPage() {
	const {connections, configured} = useLoaderData<typeof addConnectionLoader>();
	const navigate = useNavigate();
	const [params] = useSearchParams();
	const experiments = useExperiments();

	return (
		<AppShell
			title={
				<>
					<BackButton to="/connections" label="Back to connections" />
					<PageTitle>Add connection</PageTitle>
				</>
			}
		>
			<SignInFailed error={params.get('error')} configured={configured} />
			<IntegrationCatalog
				connections={connections}
				configured={configured}
				experiments={experiments}
				onConnectForm={(integrationId) => navigate(`/connections/new/${integrationId}`)}
				onConnected={(connection) => navigate(`/connections/${connection.id}?added`)}
			/>
		</AppShell>
	);
}
