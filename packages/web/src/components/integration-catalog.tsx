import type {IntegrationId} from '@proxy/integrations';
import {PlusIcon} from 'lucide-react';
import {IntegrationLogo} from '@/components/brand-logo';
import {IconButton} from '@/components/icon-button';
import {RowList} from '@/components/row-list';
import {INTEGRATIONS} from '@/lib/integrations';
import type {Connection} from '@/lib/types';

// The integrations connected by signing in to them. Their sign-in starts at
// `/api/connections/<id>/start`: the api sends the browser on to the service, and back to the new
// connection, or to the catalog with `?error=<id>` when it didn't finish. Started with
// `?returnTo=welcome`, it comes back to the welcome flow's page for the connection, or its catalog.
const SIGN_IN: IntegrationId[] = ['granola', 'notion', 'linear'];

// The catalog: every integration, a plus to connect it, and how many accounts are connected. Each
// can be connected again, for another mailbox or account.
export function IntegrationCatalog({
	connections,
	returnTo,
	onConnectEmail,
}: {
	connections: Connection[];
	returnTo?: 'welcome';
	onConnectEmail: () => void;
}) {
	const available = INTEGRATIONS.filter((integration) => !integration.builtIn);
	const startQuery = returnTo ? `?returnTo=${returnTo}` : '';

	return (
		<RowList>
			{available.map((integration) => {
				const count = connections.filter(
					(connection) => connection.integrationId === integration.id,
				).length;
				return (
					<li
						key={integration.id}
						className="flex min-h-14 items-center gap-3 px-4 py-2 text-sm md:px-3"
					>
						<IntegrationLogo integration={integration} className="size-7" />
						<div className="grid min-w-0 flex-1">
							<span className="truncate">{integration.name}</span>
							<span className="truncate text-sm text-muted-foreground">
								{integration.description}
							</span>
						</div>
						{count > 0 && (
							<span className="shrink-0 text-muted-foreground tabular-nums">{count} connected</span>
						)}
						{SIGN_IN.includes(integration.id) ? (
							<IconButton
								label={
									count > 0
										? `Add another ${integration.name} account`
										: `Sign in with ${integration.name}`
								}
								href={`/api/connections/${integration.id}/start${startQuery}`}
							>
								<PlusIcon />
							</IconButton>
						) : (
							<IconButton
								label={count > 0 ? 'Connect another mailbox' : 'Connect a mailbox'}
								onClick={onConnectEmail}
							>
								<PlusIcon />
							</IconButton>
						)}
					</li>
				);
			})}
		</RowList>
	);
}
