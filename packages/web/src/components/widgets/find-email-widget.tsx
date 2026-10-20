import {InboxIcon} from 'lucide-react';
import type {Intent} from '@/client/intent-client';
import {ConnectWidget} from '@/components/widgets/connect-widget';
import {Missing, WidgetFrame} from '@/components/widgets/widget-frame';
import {useEmails} from '@/lib/widget-lookups';
import {emailQuery, senderName, shortDay, termsRead} from '@/lib/widget-values';

const SHORT_DAY = new Intl.DateTimeFormat(undefined, {month: 'short', day: 'numeric'});

// Find email: what it searches for, from the sender, the topic and the day it goes back to, and
// the newest emails every mailbox finds, each opening where it can.
export function FindEmailWidget({intent, typed, now}: {intent: Intent; typed: string; now: Date}) {
	const query = emailQuery(intent, typed, now);
	const emails = useEmails(query);
	const sources = emails.data?.sources ?? [];

	if (emails.data && sources.length === 0) {
		return (
			<ConnectWidget icon={InboxIcon} name="Find email" collectionIds={['emails']}>
				Connect a mailbox to search your email from here.
			</ConnectWidget>
		);
	}

	const found = emails.data?.emails ?? [];
	const described = [
		...(query.from ? [`from ${query.from}`] : []),
		...(query.words.length > 0 ? [`about ${termsRead(query.words)}`] : []),
		...(query.since ? [`since ${SHORT_DAY.format(new Date(`${query.since}T00:00`))}`] : []),
	];

	return (
		<WidgetFrame icon={InboxIcon} name="Find email" failed={emails.data?.failed}>
			<p className="truncate">
				<span className="text-muted-foreground">Email </span>
				{described.length === 0 ? <Missing>of every kind</Missing> : described.join(' · ')}
			</p>
			<ul className="flex flex-col" aria-label="Emails">
				{found.length === 0 && (
					<li className="text-muted-foreground">
						{emails.loading ? 'Searching…' : 'No emails match.'}
					</li>
				)}
				{found.map((email) => {
					const account =
						sources.length > 1
							? sources.find((source) => source.connectionId === email.connectionId)?.account
							: null;
					const row = (
						<>
							<span className={`w-32 shrink-0 truncate ${email.unread ? 'font-medium' : ''}`}>
								{senderName(email.from)}
							</span>
							<span className="min-w-0 flex-1 truncate text-muted-foreground">
								{email.subject || '(no subject)'}
							</span>
							{account && (
								<span className="hidden w-32 shrink-0 truncate text-muted-foreground md:inline">
									{account}
								</span>
							)}
							<span className="shrink-0 text-muted-foreground tabular-nums">
								{shortDay(new Date(email.date))}
							</span>
						</>
					);
					return (
						<li key={`${email.connectionId} ${email.id}`} className="-mx-(--bleed)">
							{email.link ? (
								<a
									href={email.link}
									target="_blank"
									rel="noreferrer"
									className="flex h-10 min-w-0 items-center gap-3 px-(--bleed) hover:bg-muted"
								>
									{row}
								</a>
							) : (
								<div className="flex h-10 min-w-0 items-center gap-3 px-(--bleed)">{row}</div>
							)}
						</li>
					);
				})}
			</ul>
		</WidgetFrame>
	);
}
