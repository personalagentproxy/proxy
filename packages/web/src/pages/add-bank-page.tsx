import {useNavigate} from 'react-router';
import {AppShell, PageTitle} from '@/components/app-shell';
import {BackButton} from '@/components/back-button';
import {ConnectBankForm} from '@/components/connect-bank-form';
import {PLAID_FORM} from '@/lib/integrations';

// Connecting a bank through Plaid, from the catalog's plus. Connecting lands on the new
// connection's page, its permissions first.
export function AddBankPage() {
	const navigate = useNavigate();

	return (
		<AppShell
			title={
				<>
					<BackButton to="/connections/new" label="Back to the catalog" />
					<PageTitle>{PLAID_FORM.title}</PageTitle>
				</>
			}
		>
			<div className="grid gap-4">
				<p className="text-sm text-muted-foreground">{PLAID_FORM.intro}</p>
				<ConnectBankForm
					onConnected={(connection) => navigate(`/connections/${connection.id}?added`)}
				/>
			</div>
		</AppShell>
	);
}
