import {useLoaderData, useNavigate, useSearchParams} from 'react-router';
import {AppShell, PageTitle} from '@/components/app-shell';
import {BackButton} from '@/components/back-button';
import {IntegrationCatalog, SignInFailed} from '@/components/integration-catalog';
import {SharePicker} from '@/components/share-choice';
import {useExperiments} from '@/hooks/use-experiment';
import {useShareChoice} from '@/lib/share-choice';
import type {addConnectionLoader} from '@/loaders';
import {useOrgSlug} from '@/hooks/use-org';

// The catalog: a plus per integration, with how many accounts of it are connected. A mailbox, a
// database or a custom MCP server goes to its form; a sign-in starts at the api; an API key is
// taken in a dialog here. Each lands on the new connection's page. With anyone else in the
// organization or invited, it asks first who the new connection is for (`?for=everyone`), carried
// on to the form or the sign-in.
export function AddConnectionPage() {
	const org = useOrgSlug();
	const {connections, configured} = useLoaderData<typeof addConnectionLoader>();
	const navigate = useNavigate();
	const [params] = useSearchParams();
	const experiments = useExperiments();
	const {shared, query} = useShareChoice();

	return (
		<AppShell
			title={
				<>
					<BackButton to={`/${org}/connections`} label="Back to connections" />
					<PageTitle>Add connection</PageTitle>
				</>
			}
		>
			<SignInFailed error={params.get('error')} configured={configured} />
			<SharePicker />
			<IntegrationCatalog
				connections={connections}
				configured={configured}
				experiments={experiments}
				shared={shared}
				onConnectForm={(integrationId) =>
					navigate(`/${org}/connections/new/${integrationId}${query}`)
				}
				onConnected={(connection) => navigate(`/${org}/connections/${connection.id}?added`)}
			/>
		</AppShell>
	);
}
