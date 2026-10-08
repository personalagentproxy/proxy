import {useLoaderData, useNavigate, useSearchParams} from 'react-router';
import {AppShell, PageTitle} from '@/components/app-shell';
import {BackButton} from '@/components/back-button';
import {IntegrationCatalog} from '@/components/integration-catalog';
import {signInFailedMessage} from '@/lib/integrations';
import type {addConnectionLoader} from '@/loaders';

// The catalog: a plus per integration, with how many accounts of it are connected. A mailbox goes
// to its form; a sign-in starts at the api. Either lands on the new connection's page.
export function AddConnectionPage() {
	const {connections} = useLoaderData<typeof addConnectionLoader>();
	const navigate = useNavigate();
	const [params] = useSearchParams();
	const failed = signInFailedMessage(params.get('error'));

	return (
		<AppShell
			title={
				<>
					<BackButton to="/connections" label="Back to connections" />
					<PageTitle>Add connection</PageTitle>
				</>
			}
		>
			{failed && <p className="mb-4 text-sm text-destructive md:px-3">{failed}</p>}
			<IntegrationCatalog
				connections={connections}
				onConnectEmail={() => navigate('/connections/new/email')}
			/>
		</AppShell>
	);
}
