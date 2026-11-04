import type {Alert} from '@proxy/contracts/alerts';
import {describeCriteria, isWatchCollection, WATCH_COLLECTIONS} from '@proxy/utils/alerts';
import {Trash2Icon} from 'lucide-react';
import {useEffect, useState} from 'react';
import {useLoaderData, useRevalidator} from 'react-router';
import {deleteAlert} from '@/client/alerts-client';
import {AppShell, PageTitle} from '@/components/app-shell';
import {ConfirmDialog} from '@/components/confirm-dialog';
import {Head} from '@/components/head';
import {IconButton} from '@/components/icon-button';
import {EmptyRows, Row, RowHeader, RowList} from '@/components/row-list';
import {useOrgSlug} from '@/hooks/use-org';
import {counted, formatAgo, formatDateTime} from '@/lib/format';
import {describeFetchError} from '@/lib/loader-utils';
import type {alertsLoader} from '@/loaders';
import {cn} from '@proxy/ui/lib/utils';

// How often the list is read again while the page is open: a look or a match shows within a
// moment.
const POLL_MS = 15_000;

// Widths and visibility shared by the header and every row, so the columns line up.
const CELLS = {
	agent: 'hidden w-28 shrink-0 truncate text-muted-foreground md:block',
	when: 'w-32 shrink-0 text-right text-muted-foreground tabular-nums',
};

// Whether the alert is still going.
function isActive(alert: Alert): boolean {
	return alert.endedAt === null;
}

function collectionName(collectionId: string): string {
	return isWatchCollection(collectionId) ? WATCH_COLLECTIONS[collectionId].name : collectionId;
}

// "At Nov 4, 9:00 AM"; "Emails in Gmail (a@example.com) and Work mail, for from contains …".
function what(alert: Alert): string {
	if (alert.collectionId === null) {
		return alert.at === null ? 'Once' : `At ${formatDateTime(alert.at)}`;
	}
	const names = alert.connections.map((connection) => connection.name);
	const where =
		names.length === 0
			? 'no connection'
			: names.length === 1
				? (names[0] ?? '')
				: `${names.slice(0, -1).join(', ')} and ${names.at(-1) ?? ''}`;
	const name = collectionName(alert.collectionId);
	return `${name.charAt(0).toUpperCase()}${name.slice(1)} in ${where}, for ${describeCriteria(alert.criteria)}`;
}

// How it ended, in a few words.
function ending(alert: Alert): string {
	if (alert.endedAt === null) {
		return '';
	}
	const when = formatDateTime(alert.endedAt);
	if (alert.endedBy === 'fired') {
		return `Fired ${when}`;
	}
	if (alert.endedBy === 'agent') {
		return `Ended by the agent ${when}`;
	}
	if (alert.endedBy === 'connection_gone') {
		return `Ended ${when}: the connection is gone`;
	}
	return `Ended ${when}: it could not be run`;
}

// What has happened with it: for a watch still going, its looks and matches; for one ended, how.
function status(alert: Alert): string {
	if (!isActive(alert)) {
		return ending(alert);
	}
	const parts: string[] = [];
	if (alert.lastPolledAt !== null) {
		parts.push(`Looked ${formatAgo(alert.lastPolledAt).toLowerCase()}`);
	}
	if (alert.matchCount > 0) {
		parts.push(`Matched ${counted(alert.matchCount, 'time')}`);
	}
	if (alert.pollError !== null) {
		parts.push(`The last look failed: ${alert.pollError}`);
	}
	return parts.join(' · ');
}

// The right-hand cell: when a timed alert is due, that a watch is watching, or that it has ended.
function when(alert: Alert): string {
	if (alert.endedAt !== null) {
		return 'Ended';
	}
	if (alert.at !== null) {
		return formatDateTime(alert.at);
	}
	return 'Watching';
}

// The person's alerts in the organization open, newest first: those going on, then those ended.
// Each is what an agent set in the person's conversation with it, told there when it is due or
// something matches; the person deletes them here, and asks the agent for new ones.
export function AlertsPage() {
	const org = useOrgSlug();
	const {alerts} = useLoaderData<typeof alertsLoader>();
	const revalidator = useRevalidator();
	const [deleting, setDeleting] = useState<Alert | null>(null);
	const [error, setError] = useState<string | null>(null);

	// The list as it is now, while the page is open.
	useEffect(() => {
		const timer = setInterval(() => void revalidator.revalidate(), POLL_MS);
		return () => {
			clearInterval(timer);
		};
	}, [revalidator]);

	const remove = async (alert: Alert) => {
		const removed = await deleteAlert(org, alert.id);
		if (removed.isErr()) {
			setError(describeFetchError(removed.error));
			return;
		}
		setError(null);
		await revalidator.revalidate();
	};

	const active = alerts.filter(isActive);
	const ordered = [...active, ...alerts.filter((alert) => !isActive(alert))];

	return (
		<AppShell title={<PageTitle detail={`${active.length} active`}>Alerts</PageTitle>}>
			<ConfirmDialog
				open={deleting !== null}
				title={deleting ? `Delete “${deleting.title}”?` : ''}
				description={
					deleting && isActive(deleting)
						? 'The agent stops watching for it, and nothing more comes of it.'
						: 'This takes it off the list, with what it matched.'
				}
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
				{ordered.length === 0 && (
					<EmptyRows>
						No alerts yet. Ask an agent in Chat to tell you at a time, or when something happens in
						your accounts.
					</EmptyRows>
				)}
				{ordered.map((alert) => (
					<Row
						key={alert.id}
						to={`/${org}/chat/${alert.persona.id}`}
						icon={
							<Head
								look={alert.persona.look}
								color={alert.persona.color}
								size={20}
								className={cn('shrink-0', !isActive(alert) && 'opacity-50')}
							/>
						}
						title={
							<span className={cn(!isActive(alert) && 'text-muted-foreground')}>{alert.title}</span>
						}
						subtitle={
							<span className="flex flex-col gap-0.5 text-xs">
								<span className="line-clamp-2">{what(alert)}</span>
								{status(alert) !== '' && <span className="truncate">{status(alert)}</span>}
								{alert.matches.map((match) => (
									<span key={match.id} className="truncate text-foreground">
										{formatDateTime(match.at)} · {match.title} · {match.summary}
									</span>
								))}
							</span>
						}
						cells={
							<>
								<span className={CELLS.agent}>{alert.persona.name}</span>
								<span className={CELLS.when}>{when(alert)}</span>
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
