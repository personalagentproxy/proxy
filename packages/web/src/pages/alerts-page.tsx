import type {Alert} from '@proxy/contracts/alerts';
import {Trash2Icon} from 'lucide-react';
import {useState} from 'react';
import {useLoaderData, useRevalidator} from 'react-router';
import {deleteAlert} from '@/client/alerts-client';
import {AlertDetailDialog} from '@/components/alert-detail-dialog';
import {AppShell, PageTitle} from '@/components/app-shell';
import {IntegrationLogo} from '@/components/brand-logo';
import {ConfirmDialog} from '@/components/confirm-dialog';
import {Head} from '@/components/head';
import {IconButton} from '@/components/icon-button';
import {EmptyRows, Row, RowHeader, RowList} from '@/components/row-list';
import {useOrgSlug} from '@/hooks/use-org';
import {formatAgo, formatDateTime} from '@/lib/format';
import {findIntegration, type Integration} from '@/lib/integrations';
import {describeFetchError} from '@/lib/loader-utils';
import type {alertsLoader} from '@/loaders';

// Widths and visibility shared by the header and every row, so the columns line up.
const CELLS = {
	where: 'hidden w-20 shrink-0 items-center gap-1 sm:flex',
	created: 'hidden w-20 shrink-0 text-right text-muted-foreground tabular-nums sm:block',
	matched: 'w-36 shrink-0 text-right text-muted-foreground tabular-nums',
	agent: 'hidden w-28 shrink-0 truncate text-muted-foreground md:block',
};

// The integrations a watch looks in, one logo each however many connections of it; none for a
// timed alert.
function integrationsOf(alert: Alert): Integration[] {
	const seen = new Map<string, Integration>();
	for (const connection of alert.connections) {
		const integration = findIntegration(connection.integrationId);
		if (integration) {
			seen.set(integration.id, integration);
		}
	}
	return [...seen.values()];
}

// When a watch last matched, or when a timed alert is due, which is the one time it matches.
function matched(alert: Alert): string {
	if (alert.at !== null) {
		return `Due ${formatDateTime(alert.at)}`;
	}
	return alert.lastMatchedAt === null ? 'Never' : formatAgo(alert.lastMatchedAt);
}

// The person's alerts in the organization, newest first: each what an agent set in the person's
// conversation with it, told there when it is due or something matches. A row opens the alert in
// full; the person deletes them here, and asks the agent for new ones.
export function AlertsPage() {
	const org = useOrgSlug();
	const {alerts} = useLoaderData<typeof alertsLoader>();
	const revalidator = useRevalidator();
	const [shown, setShown] = useState<Alert | null>(null);
	const [deleting, setDeleting] = useState<Alert | null>(null);
	const [error, setError] = useState<string | null>(null);

	const remove = async (alert: Alert) => {
		const removed = await deleteAlert(org, alert.id);
		if (removed.isErr()) {
			setError(describeFetchError(removed.error));
			return;
		}
		setError(null);
		await revalidator.revalidate();
	};

	return (
		<AppShell title={<PageTitle detail={`${alerts.length} set`}>Alerts</PageTitle>}>
			<AlertDetailDialog alert={shown} onClose={() => setShown(null)} />
			<ConfirmDialog
				open={deleting !== null}
				title={deleting ? `Delete “${deleting.title}”?` : ''}
				description="The agent stops watching for it, and nothing more comes of it."
				confirmLabel="Delete"
				destructive
				onClose={() => setDeleting(null)}
				onConfirm={() => {
					if (!deleting) {
						return;
					}
					void remove(deleting);
					setDeleting(null);
				}}
			/>
			{error !== null && <p className="text-sm text-destructive">{error}</p>}
			<RowList
				header={
					<RowHeader>
						<span className="size-5 shrink-0" />
						<span className="min-w-0 flex-1">Alert</span>
						<span className={CELLS.where}>Where</span>
						<span className={CELLS.created}>Created</span>
						<span className={CELLS.matched}>Last matched</span>
						<span className={CELLS.agent}>Agent</span>
						{/* As wide as the delete button beside each row, so the columns line up with the header. */}
						<span className="hidden w-8 shrink-0 sm:block" />
					</RowHeader>
				}
			>
				{alerts.length === 0 && (
					<EmptyRows>
						No alerts set. Ask an agent in Chat to tell you at a time, or when something happens in
						your accounts.
					</EmptyRows>
				)}
				{alerts.map((alert) => (
					<Row
						key={alert.id}
						onClick={() => setShown(alert)}
						icon={
							<Head
								look={alert.persona.look}
								color={alert.persona.color}
								size={20}
								className="shrink-0"
							/>
						}
						title={alert.title}
						cells={
							<>
								<span className={CELLS.where}>
									{integrationsOf(alert).map((integration) => (
										<span key={integration.id} title={integration.name}>
											<IntegrationLogo integration={integration} />
										</span>
									))}
								</span>
								<span className={CELLS.created}>{formatAgo(alert.createdAt)}</span>
								<span className={CELLS.matched}>{matched(alert)}</span>
								<span className={CELLS.agent}>{alert.persona.name}</span>
							</>
						}
						after={
							<IconButton label={`Delete ${alert.title}`} onClick={() => setDeleting(alert)}>
								<Trash2Icon />
							</IconButton>
						}
					/>
				))}
			</RowList>
		</AppShell>
	);
}
