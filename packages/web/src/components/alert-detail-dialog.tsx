import type {Alert} from '@proxy/contracts/alerts';
import type {ReactNode} from 'react';
import {Link} from 'react-router';
import {Badge} from '@proxy/ui/components/badge';
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
} from '@proxy/ui/components/dialog';
import {IntegrationLogo} from '@/components/brand-logo';
import {ThreadLink} from '@/components/chat/thread-link';
import {Head} from '@/components/head';
import {useOrgSlug} from '@/hooks/use-org';
import {formatDateTime} from '@/lib/format';
import {findIntegration} from '@/lib/integrations';

type Props = {
	// The alert shown, or null while the dialog is closed.
	alert: Alert | null;
	onClose: () => void;
};

// "Wednesday, October 14, 2026 at 11:15 PM".
function formatMoment(iso: string): string {
	return new Date(iso).toLocaleString('en-US', {
		weekday: 'long',
		month: 'long',
		day: 'numeric',
		year: 'numeric',
		hour: 'numeric',
		minute: '2-digit',
	});
}

function Detail({label, children}: {label: string; children: ReactNode}) {
	return (
		<div className="flex gap-3 py-2">
			<dt className="w-28 shrink-0 text-muted-foreground">{label}</dt>
			<dd className="flex min-w-0 flex-1 flex-wrap items-center gap-1.5">{children}</dd>
		</div>
	);
}

// What the dialog says of an alert under its title: when it comes, once or again and again, or what
// it watches.
function comes(alert: Alert): string {
	if (alert.at === null) {
		return `Watching ${alert.collection ?? ''}`;
	}
	if (alert.every !== null) {
		return `Repeats ${alert.every}`;
	}
	return `Once, ${formatMoment(alert.at)}`;
}

// How a watch that opens new threads splits what it finds, in words.
function splitText(split: NonNullable<Alert['split']>): string {
	return split === 'per_record' ? 'A thread for each record' : 'A thread for each check';
}

// An alert in full: what it is, when it comes again where it repeats, where it watches and for
// which words, where it comes, into its thread, with a link to it, or as a new thread each time,
// and the thread it was set in, each linked where it lives, in Chat or in Slack, what the agent
// noted for it, who set it, with a link to the chat, and when it last matched.
export function AlertDetailDialog({alert, onClose}: Props) {
	return (
		<Dialog
			open={alert !== null}
			onOpenChange={(next) => {
				if (next) {
					return;
				}
				onClose();
			}}
		>
			{alert && <AlertDetailContent alert={alert} />}
		</Dialog>
	);
}

function AlertDetailContent({alert}: {alert: Alert}) {
	const org = useOrgSlug();
	return (
		<DialogContent className="grid-cols-[minmax(0,1fr)] sm:max-w-lg">
			<DialogHeader>
				<DialogTitle className="pr-8 leading-snug break-words">{alert.title}</DialogTitle>
				<DialogDescription>{comes(alert)}</DialogDescription>
			</DialogHeader>
			<dl className="divide-y text-sm">
				{alert.at !== null && (
					<Detail label={alert.every === null ? 'Due' : 'Next'}>{formatMoment(alert.at)}</Detail>
				)}
				{alert.every !== null && <Detail label="Repeats">{alert.every}</Detail>}
				{alert.at === null && (
					<Detail label="Watching">
						{alert.connections.length === 0 && (
							<span className="text-muted-foreground">A connection that is gone</span>
						)}
						{alert.connections.map((connection) => {
							const integration = findIntegration(connection.integrationId);
							return (
								<Badge key={connection.id} variant="secondary" className="gap-1.5">
									{integration && <IntegrationLogo integration={integration} className="size-4" />}
									{connection.name}
								</Badge>
							);
						})}
					</Detail>
				)}
				{alert.at === null && (
					<Detail label="Words">
						{alert.terms.length === 0 && (
							<span className="text-muted-foreground">Anything new</span>
						)}
						{alert.terms.map((term) => (
							<Badge key={term} variant="outline">
								{term}
							</Badge>
						))}
					</Detail>
				)}
				<Detail label="Comes to">
					{alert.thread === null ? (
						<span>A new thread each time</span>
					) : (
						<ThreadLink thread={{...alert.thread, personaId: alert.persona.id}} />
					)}
				</Detail>
				{alert.split !== null && <Detail label="Threads">{splitText(alert.split)}</Detail>}
				{alert.thread?.id !== alert.setIn?.id && (
					<Detail label="Set in">
						{alert.setIn === null ? (
							<span className="text-muted-foreground">A thread that is gone</span>
						) : (
							<ThreadLink thread={{...alert.setIn, personaId: alert.persona.id}} />
						)}
					</Detail>
				)}
				<Detail label="Note">
					<span className="min-w-0 break-words">{alert.brief}</span>
				</Detail>
				<Detail label="Agent">
					<Head look={alert.persona.look} color={alert.persona.color} size={20} />
					<Link
						to={`/${org}/chat/${alert.persona.id}`}
						className="min-w-0 truncate hover:underline"
					>
						{alert.persona.name}
					</Link>
				</Detail>
				<Detail label="Created">{formatDateTime(alert.createdAt)}</Detail>
				{alert.at === null && (
					<Detail label="Last matched">
						{alert.lastMatchedAt === null ? (
							<span className="text-muted-foreground">Never</span>
						) : (
							formatDateTime(alert.lastMatchedAt)
						)}
					</Detail>
				)}
			</dl>
		</DialogContent>
	);
}
