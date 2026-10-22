import {useNavigate} from 'react-router';
import {AppShell, PageTitle} from '@/components/app-shell';
import {BackButton} from '@/components/back-button';
import {ConnectMcpForm} from '@/components/connect-mcp-form';
import {ShareNote} from '@/components/share-choice';
import {useShareChoice} from '@/lib/share-choice';
import {useOrgSlug} from '@/hooks/use-org';

// The custom MCP server form, from the catalog's plus. Connecting lands on the new connection's
// page, its tools first.
export function AddMcpPage() {
	const org = useOrgSlug();
	const navigate = useNavigate();
	const {shared, query} = useShareChoice();

	return (
		<AppShell
			title={
				<>
					<BackButton to={`/${org}/connections/new${query}`} label="Back to the catalog" />
					<PageTitle>Connect an MCP server</PageTitle>
				</>
			}
		>
			<div className="grid gap-4">
				<ShareNote actsAs="you, or the token you give" />
				<p className="text-sm text-muted-foreground">
					Any MCP server over HTTP. Its tools become what agents can be allowed, one by one: the
					ones that only read are on from the start, the rest off until you turn them on.
				</p>
				<ConnectMcpForm
					shared={shared}
					onConnected={(connection) => navigate(`/${org}/connections/${connection.id}?added`)}
				/>
			</div>
		</AppShell>
	);
}
