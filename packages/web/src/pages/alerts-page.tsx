import type {Alert} from '@proxy/contracts/alerts';
import {Trash2Icon} from 'lucide-react';
import {useState} from 'react';
import {useLoaderData, useRevalidator} from 'react-router';
import {deleteAlert} from '@/client/alerts-client';
import {AppShell, PageTitle} from '@/components/app-shell';
import {ConfirmDialog} from '@/components/confirm-dialog';
import {Head} from '@/components/head';
import {IconButton} from '@/components/icon-button';
import {EmptyRows, Row, RowHeader, RowList} from '@/components/row-list';
import {useOrgSlug} from '@/hooks/use-org';
import {formatDateTime} from '@/lib/format';
import {describeFetchError} from '@/lib/loader-utils';
import type {alertsLoader} from '@/loaders';

// Widths and visibility shared by the header and every row, so the columns line up.
const CELLS = {
	agent: 'hidden w-28 shrink-0 truncate text-muted-foreground md:block',
	when: 'w-32 shrink-0 text-right text-muted-foreground tabular-nums',
};

// "a and b", "a, b or c".
function joined(names: string[], last: 'and' | 'or'): string {
	if (names.length <= 1) {
		return names.join('');
	}
	return `${names.slice(0, -1).join(', ')} ${last} ${names.at(-1) ?? ''}`;
}

// "Emails in Gmail (a@example.com), for “loan” or “mortgage”"; "Once, at Nov 4, 9:00 AM".
function what(alert: Alert): string {
	if (alert.collection === null) {
		return alert.at === null ? 'Once' : `Once, at ${formatDateTime(alert.at)}`;
	}
	const where =
		alert.connections.length === 0
			? 'a connection that is gone'
			: joined(
					alert.connections.map((connection) => connection.name),
					'and',
				);
	const terms =
		alert.terms.length === 0
			? 'anything new'
			: joined(
					alert.terms.map((term) => `“${term}”`),
					'or',
				);
	return `${alert.collection.charAt(0).toUpperCase()}${alert.collection.slice(1)} in ${where}, for ${terms}`;
}

// The person's alerts in the organization, newest first: each what an agent set in the person's
// conversation with it, told there when it is due or something matches. The person deletes them
// here, and asks the agent for new ones.
export function AlertsPage() {
	const org = useOrgSlug();
	const {alerts} = useLoaderData<typeof alertsLoader>();
	const revalidator = useRevalidator();
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
						<span className={CELLS.agent}>Agent</span>
						<span className={CELLS.when}>Due</span>
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
						to={`/${org}/chat/${alert.persona.id}`}
						icon={
							<Head
								look={alert.persona.look}
								color={alert.persona.color}
								size={20}
								className="shrink-0"
							/>
						}
						title={alert.title}
						subtitle={<span className="line-clamp-2 text-xs">{what(alert)}</span>}
						cells={
							<>
								<span className={CELLS.agent}>{alert.persona.name}</span>
								<span className={CELLS.when}>
									{alert.at === null ? 'Watching' : formatDateTime(alert.at)}
								</span>
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
