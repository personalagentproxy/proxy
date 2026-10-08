import {useNavigate} from 'react-router';
import {AppShell, PageTitle} from '@/components/app-shell';
import {BackButton} from '@/components/back-button';
import {ConnectEmailForm} from '@/components/connect-email-form';

// The mailbox form, from the catalog's plus. Connecting lands on the new connection's page, its
// permissions first.
export function AddEmailPage() {
	const navigate = useNavigate();

	return (
		<AppShell
			title={
				<>
					<BackButton to="/connections/new" label="Back to the catalog" />
					<PageTitle>Connect a mailbox</PageTitle>
				</>
			}
		>
			<div className="grid gap-4">
				<p className="text-sm text-muted-foreground">
					Personal Agent Proxy signs in with an app password, made for Personal Agent Proxy alone in
					your mail account. Revoking it there disconnects Personal Agent Proxy.
				</p>
				<ConnectEmailForm
					onConnected={(connection) => navigate(`/connections/${connection.id}?added`)}
				/>
			</div>
		</AppShell>
	);
}
