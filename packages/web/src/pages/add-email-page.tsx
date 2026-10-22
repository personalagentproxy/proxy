import {useNavigate} from 'react-router';
import {AppShell, PageTitle} from '@/components/app-shell';
import {BackButton} from '@/components/back-button';
import {ConnectEmailForm} from '@/components/connect-email-form';
import {ShareNote} from '@/components/share-choice';
import {EMAIL_FORM} from '@/lib/integrations';
import {useShareChoice} from '@/lib/share-choice';
import {useOrgSlug} from '@/hooks/use-org';

// The mailbox form, from the catalog's plus. Connecting lands on the new connection's page, its
// permissions first.
export function AddEmailPage() {
	const org = useOrgSlug();
	const navigate = useNavigate();
	const {shared, query} = useShareChoice();

	return (
		<AppShell
			title={
				<>
					<BackButton to={`/${org}/connections/new${query}`} label="Back to the catalog" />
					<PageTitle>{EMAIL_FORM.title}</PageTitle>
				</>
			}
		>
			<div className="grid gap-4">
				<ShareNote actsAs="the mailbox" />
				<p className="text-sm text-muted-foreground">{EMAIL_FORM.intro}</p>
				<ConnectEmailForm
					shared={shared}
					onConnected={(connection) => navigate(`/${org}/connections/${connection.id}?added`)}
				/>
			</div>
		</AppShell>
	);
}
