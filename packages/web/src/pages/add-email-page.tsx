import {useNavigate} from 'react-router';
import {AppShell, PageTitle} from '@/components/app-shell';
import {BackButton} from '@/components/back-button';
import {ConnectEmailForm} from '@/components/connect-email-form';
import {EMAIL_FORM} from '@/lib/integrations';

// The mailbox form, from the catalog's plus. Connecting lands on the new connection's page, its
// permissions first.
export function AddEmailPage() {
	const navigate = useNavigate();

	return (
		<AppShell
			title={
				<>
					<BackButton to="/connections/new" label="Back to the catalog" />
					<PageTitle>{EMAIL_FORM.title}</PageTitle>
				</>
			}
		>
			<div className="grid gap-4">
				<p className="text-sm text-muted-foreground">{EMAIL_FORM.intro}</p>
				<ConnectEmailForm
					onConnected={(connection) => navigate(`/connections/${connection.id}?added`)}
				/>
			</div>
		</AppShell>
	);
}
