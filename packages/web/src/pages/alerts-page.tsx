import type {Alert} from '@proxy/contracts/alerts';
import {FilterIcon, MessageSquareIcon, Trash2Icon, XIcon} from 'lucide-react';
import {type ReactNode, useState} from 'react';
import {Link, useNavigate, useSearchParams} from 'react-router';
import {deleteAlert} from '@/client/alerts-client';
import {AlertDetailDialog} from '@/components/alert-detail-dialog';
import {AppShell, PageTitle} from '@/components/app-shell';
import {IntegrationLogo} from '@/components/brand-logo';
import {ConfirmDialog} from '@/components/confirm-dialog';
import {ContextMenuItem} from '@proxy/ui/components/context-menu';
import {PillButton} from '@proxy/ui/components/pill-button';
import {Head} from '@/components/head';
import {IconButton} from '@/components/icon-button';
import {EmptyRows, Row, RowHeader, RowList} from '@/components/row-list';
import {useLoaded} from '@/hooks/use-loaded';
import {useOrgSlug} from '@/hooks/use-org';
import {useReload} from '@/hooks/use-reload';
import {formatAgo, formatDateTime} from '@/lib/format';
import {threadOf, threadTo} from '@/lib/alerts';
import {findIntegration, type Integration} from '@/lib/integrations';
import {describeFetchError} from '@/lib/loader-utils';
import type {alertsLoader} from '@/loaders';

// Widths and visibility shared by the header and every row, so the columns line up.
const CELLS = {
	where: 'hidden w-20 shrink-0 items-center gap-1 sm:flex',
	created: 'hidden w-20 shrink-0 text-right text-muted-foreground tabular-nums sm:block',
	matched: 'w-36 shrink-0 truncate text-right text-muted-foreground tabular-nums',
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

// When a watch last matched, or when a timed alert is next due, which is when it matches, saying
// so where it repeats.
function matched(alert: Alert): string {
	if (alert.at !== null) {
		return `Due ${formatDateTime(alert.at)}${alert.every === null ? '' : ' · repeats'}`;
	}
	return alert.lastMatchedAt === null ? 'Never' : formatAgo(alert.lastMatchedAt);
}

// A link back to the thread or the chat the page is narrowed to.
const BACK_LINK = 'text-foreground underline-offset-4 hover:underline';

// The alerts the address narrows the page to: those that come to one thread (`?thread=`), as a
// thread's line of its alerts links here, or those of one agent's chat that open threads of their
// own (`?chat=`, the agent's id), as the chat's line links here; null for every one. It says which,
// by the thread's title or the agent's name, a link back there.
function filterOf(
	org: string,
	params: URLSearchParams,
	all: Alert[],
): {keeps: (alert: Alert) => boolean; label: ReactNode; none: string} | null {
	const threadId = params.get('thread');
	if (threadId !== null) {
		const comes = all.find((alert) => alert.thread?.id === threadId);
		return {
			keeps: (alert) => alert.thread?.id === threadId,
			label:
				comes === undefined || comes.thread === null ? (
					'Alerts of one thread'
				) : (
					<>
						Alerts of the thread{' '}
						<Link to={threadTo(org, comes)} className={BACK_LINK}>
							“{comes.thread.title || 'Thread'}”
						</Link>
					</>
				),
			none: 'No alerts come to this thread.',
		};
	}
	const personaId = params.get('chat');
	if (personaId === null) {
		return null;
	}
	const persona = all.find((alert) => alert.persona.id === personaId)?.persona ?? null;
	return {
		keeps: (alert) => alert.opens === 'new_thread' && alert.persona.id === personaId,
		label:
			persona === null ? (
				'Alerts of one chat'
			) : (
				<>
					Alerts that open threads in the chat with{' '}
					<Link to={`/${org}/chat/${persona.id}`} className={BACK_LINK}>
						{persona.name}
					</Link>
				</>
			),
		none: 'No alerts open threads in this chat.',
	};
}

// The person's alerts in the organization, newest first: each what an agent set in one of the
// threads of the person's conversation with it, and where it comes, into that thread or as a new
// one, when it is due or something matches. Those of one thread or one chat alone where the
// address says (`filterOf`), with a way back to them all. A row
// opens the alert in full, and its menu the thread it comes to; the person deletes them here, and
// asks the agent for new ones.
export function AlertsPage() {
	return (
		<AppShell title={<PageTitle>Alerts</PageTitle>}>
			<Alerts />
		</AppShell>
	);
}

function Alerts() {
	const org = useOrgSlug();
	const {alerts: all} = useLoaded<typeof alertsLoader>();
	const reload = useReload();
	const navigate = useNavigate();
	const [params, setParams] = useSearchParams();
	const filter = filterOf(org, params, all);
	const alerts = filter === null ? all : all.filter(filter.keeps);
	const showAll = () =>
		setParams((before) => {
			const after = new URLSearchParams(before);
			after.delete('thread');
			after.delete('chat');
			return after;
		});
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
		await reload();
	};

	return (
		<>
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
			{filter !== null && (
				<div className="flex items-center gap-2 text-sm text-muted-foreground">
					<FilterIcon className="size-3.5 shrink-0" aria-hidden />
					<span className="min-w-0 flex-1 truncate">{filter.label}</span>
					<PillButton type="button" variant="ghost" onClick={showAll}>
						<XIcon data-icon="inline-start" />
						Show all
					</PillButton>
				</div>
			)}
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
				{alerts.length === 0 && filter !== null && <EmptyRows>{filter.none}</EmptyRows>}
				{alerts.length === 0 && filter === null && (
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
						subtitle={<span className="block truncate">{threadOf(alert)}</span>}
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
						menu={
							alert.thread === null ? undefined : (
								<ContextMenuItem
									onClick={() => {
										if (alert.thread === null) {
											return;
										}
										// One in Slack opens there, as the app doesn't show it.
										if (alert.thread.slackUrl !== null) {
											window.open(alert.thread.slackUrl, '_blank', 'noreferrer');
											return;
										}
										void navigate(threadTo(org, alert));
									}}
								>
									<MessageSquareIcon />
									Open thread
								</ContextMenuItem>
							)
						}
						after={
							<IconButton label={`Delete ${alert.title}`} onClick={() => setDeleting(alert)}>
								<Trash2Icon />
							</IconButton>
						}
					/>
				))}
			</RowList>
		</>
	);
}
