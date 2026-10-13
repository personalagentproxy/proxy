import type {IntegrationId} from '@proxy/integrations';
import {buttonVariants} from '@proxy/ui/components/button';
import {cn} from '@proxy/ui/lib/utils';
import {PlusIcon} from 'lucide-react';
import {IntegrationLogo} from '@/components/brand-logo';
import {RowList} from '@/components/row-list';
import {INTEGRATIONS} from '@/lib/integrations';
import type {Connection} from '@/lib/types';

// The integrations connected by signing in to them. Their sign-in starts at
// `/api/connections/<id>/start`: the api sends the browser on to the service, and back to the new
// connection, or to the catalog with `?error=<id>` when it didn't finish. Started with
// `?returnTo=welcome`, it comes back to the welcome flow's page for the connection, or its catalog.
// The rest are connected on a form of their own: a mailbox with an app password, a database with
// a user's name and password, a custom MCP server by its address.
const SIGN_IN: IntegrationId[] = ['granola', 'notion', 'linear'];

// The whole row is the link or button; its plus is styled as a ghost icon button that lights up
// with the row.
const ROW =
	'group flex min-h-14 w-full items-center gap-3 px-4 py-2 text-left text-sm outline-none md:px-3';
const PLUS = cn(
	buttonVariants({variant: 'ghost', size: 'icon-sm'}),
	'group-hover:bg-muted group-hover:text-foreground group-focus-visible:border-ring group-focus-visible:ring-3 group-focus-visible:ring-ring/50 group-active:translate-y-px dark:group-hover:bg-muted/50',
);

// The catalog: every integration, a plus to connect it, and how many accounts are connected. Each
// can be connected again, for another mailbox, account or server.
export function IntegrationCatalog({
	connections,
	returnTo,
	onConnectForm,
}: {
	connections: Connection[];
	returnTo?: 'welcome';
	// The integration's form, by its id.
	onConnectForm: (integrationId: IntegrationId) => void;
}) {
	const available = INTEGRATIONS.filter((integration) => !integration.builtIn);
	const startQuery = returnTo ? `?returnTo=${returnTo}` : '';

	return (
		<RowList>
			{available.map((integration) => {
				const count = connections.filter(
					(connection) => connection.integrationId === integration.id,
				).length;
				const content = (
					<>
						<IntegrationLogo integration={integration} className="size-7" />
						<span className="grid min-w-0 flex-1">
							<span className="truncate">{integration.name}</span>
							<span className="truncate text-sm text-muted-foreground">
								{integration.description}
							</span>
						</span>
						{count > 0 && (
							<span className="shrink-0 text-muted-foreground tabular-nums">{count} connected</span>
						)}
						<span className={PLUS}>
							<PlusIcon />
						</span>
					</>
				);
				return (
					<li key={integration.id}>
						{SIGN_IN.includes(integration.id) ? (
							<a href={`/api/connections/${integration.id}/start${startQuery}`} className={ROW}>
								{content}
							</a>
						) : (
							<button type="button" onClick={() => onConnectForm(integration.id)} className={ROW}>
								{content}
							</button>
						)}
					</li>
				);
			})}
		</RowList>
	);
}
