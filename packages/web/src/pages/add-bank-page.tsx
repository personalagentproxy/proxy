import {useNavigate} from 'react-router';
import {AppShell, PageTitle} from '@/components/app-shell';
import {ConnectBankForm} from '@/components/connect-bank-form';
import {ShareNote} from '@/components/share-choice';
import {PLAID_FORM} from '@/lib/integrations';
import {useShareChoice} from '@/hooks/use-share-choice';
import {useOrgSlug} from '@/hooks/use-org';

// Connecting a bank through Plaid, from the catalog's plus. Connecting lands on the new
// connection's page, its permissions first.
export function AddBankPage() {
	const org = useOrgSlug();
	const navigate = useNavigate();
	const {shared} = useShareChoice();

	return (
		<AppShell title={<PageTitle>{PLAID_FORM.title}</PageTitle>}>
			<div className="grid gap-4">
				<ShareNote actsAs="the bank login" />
				<p className="text-sm text-muted-foreground">{PLAID_FORM.intro}</p>
				<ConnectBankForm
					shared={shared}
					onConnected={(connection) => navigate(`/${org}/connections/${connection.id}?added`)}
				/>
			</div>
		</AppShell>
	);
}
