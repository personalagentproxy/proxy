import {useNavigate} from 'react-router';
import type {DatabaseDialect} from '@/client/connections-client';
import {AppShell, PageTitle} from '@/components/app-shell';
import {BackButton} from '@/components/back-button';
import {ConnectDatabaseForm} from '@/components/connect-database-form';
import {ShareNote} from '@/components/share-choice';
import {describeDatabase} from '@/lib/integrations';
import {useShareChoice} from '@/lib/share-choice';

// The database form, from the catalog's plus. Connecting lands on the new connection's page, its
// permissions first.
export function AddDatabasePage({dialect}: {dialect: DatabaseDialect}) {
	const navigate = useNavigate();
	const {shared, query} = useShareChoice();
	const {title, intro} = describeDatabase(dialect);

	return (
		<AppShell
			title={
				<>
					<BackButton to={`/connections/new${query}`} label="Back to the catalog" />
					<PageTitle>{title}</PageTitle>
				</>
			}
		>
			<div className="grid gap-4">
				<ShareNote actsAs="the database user you give" />
				<p className="text-sm text-muted-foreground">{intro}</p>
				<ConnectDatabaseForm
					key={dialect}
					dialect={dialect}
					shared={shared}
					onConnected={(connection) => navigate(`/connections/${connection.id}?added`)}
				/>
			</div>
		</AppShell>
	);
}
