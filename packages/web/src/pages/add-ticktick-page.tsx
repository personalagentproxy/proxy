import {useNavigate} from 'react-router';
import {AppShell, PageTitle} from '@/components/app-shell';
import {BackButton} from '@/components/back-button';
import {ConnectTickTickForm} from '@/components/connect-ticktick-form';
import {TICKTICK_INTRO} from '@/lib/integrations';

// The TickTick form, from the catalog's plus. Connecting lands on the new connection's page, its
// permissions first.
export function AddTickTickPage() {
	const navigate = useNavigate();

	return (
		<AppShell
			title={
				<>
					<BackButton to="/connections/new" label="Back to the catalog" />
					<PageTitle>Connect TickTick</PageTitle>
				</>
			}
		>
			<div className="grid gap-4">
				<p className="text-sm text-muted-foreground">{TICKTICK_INTRO}</p>
				<ConnectTickTickForm
					onConnected={(connection) => navigate(`/connections/${connection.id}?added`)}
				/>
			</div>
		</AppShell>
	);
}
