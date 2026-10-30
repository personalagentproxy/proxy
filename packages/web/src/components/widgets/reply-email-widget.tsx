import {ReplyIcon} from 'lucide-react';
import {useState} from 'react';
import type {Intent} from '@/client/intent-client';
import {replyToEmail, type FoundEmail} from '@/client/widgets-client';
import {Button} from '@proxy/ui/components/button';
import {Skeleton} from '@proxy/ui/components/skeleton';
import {Textarea} from '@proxy/ui/components/textarea';
import {ConnectWidget} from '@/components/widgets/connect-widget';
import {WidgetFrame} from '@/components/widgets/widget-frame';
import {WidgetSelect} from '@/components/widgets/widget-select';
import {WriteResult} from '@/components/widgets/write-result';
import {useSuggested} from '@/hooks/use-suggested';
import {useEmail, useEmails, useMailboxes} from '@/hooks/widget-lookups';
import {
	emailQuery,
	emailQueryRead,
	fieldTexts,
	ownText,
	senderName,
	shortDay,
} from '@/lib/widget-values';
import {useWriteStatus} from '@/hooks/use-write-status';
import {writeErrorMessage} from '@/lib/write-status';
import {useOrgSlug} from '@/hooks/use-org';

const NAME = 'Reply to email';

function emailKey(email: FoundEmail): string {
	return `${email.connectionId} ${email.id}`;
}

// "Sam Lee: Invoice #1042 · Oct 11".
function emailLabel(email: FoundEmail): string {
	return `${senderName(email.from)}: ${email.subject || 'No subject'} · ${shortDay(new Date(email.date))}`;
}

// Reply to email: the email to answer, found by its sender, what it is about and the day it goes
// back to, the newest first and the others found to choose from, what it says, and the reply, sent
// or saved as a draft in the email's thread from the mailbox it is in.
export function ReplyEmailWidget({intent, typed, now}: {intent: Intent; typed: string; now: Date}) {
	const org = useOrgSlug();
	const query = emailQuery(intent, typed, now);
	const emails = useEmails(query);
	const mailboxes = useMailboxes(true);
	const [chosen, setChosen] = useState<string | null>(null);
	const [body, setBody] = useSuggested(fieldTexts(intent, 'body')[0] ?? '');
	const [status, setStatus] = useWriteStatus(typed);
	const sources = emails.data?.sources ?? [];
	const found = emails.data?.emails ?? [];
	const picked = found.find((email) => emailKey(email) === chosen) ?? found[0] ?? null;
	const opened = useEmail(picked && {connectionId: picked.connectionId, id: picked.id});

	if (emails.data && sources.length === 0) {
		return (
			<ConnectWidget icon={ReplyIcon} name={NAME} collectionIds={['emails']}>
				Connect a mailbox to reply to your email from here.
			</ConnectWidget>
		);
	}

	// Its mailbox can send, as the reply goes out from the mailbox the email is in.
	const sendable = mailboxes.data?.sources.some(
		(source) => source.connectionId === picked?.connectionId,
	);
	const busy = status.kind === 'saving' || status.kind === 'done';
	const described = emailQueryRead(query);

	const write = (send: boolean) => {
		if (!picked) {
			return;
		}
		setStatus({kind: 'saving'});
		void replyToEmail(org, {
			connectionId: picked.connectionId,
			emailId: picked.id,
			body,
			send,
		}).then((result) => {
			if (result.isErr()) {
				setStatus({kind: 'failed', message: writeErrorMessage(result.error)});
				return;
			}
			setStatus({kind: 'done', message: send ? 'Sent' : 'Saved as a draft', link: null});
		});
	};

	return (
		<WidgetFrame
			icon={ReplyIcon}
			name={NAME}
			failed={emails.data?.failed}
			status={<WriteResult status={status} />}
			actions={
				<>
					<Button
						size="sm"
						variant="outline"
						onClick={() => write(false)}
						disabled={!picked || busy}
					>
						Save draft
					</Button>
					<Button
						size="sm"
						onClick={() => write(true)}
						disabled={!picked || !sendable || body.trim() === '' || busy}
					>
						Send
					</Button>
				</>
			}
		>
			<div className="flex min-w-0 items-center gap-2">
				<span className="shrink-0 text-muted-foreground">Re</span>
				{found.length > 1 && picked ? (
					<WidgetSelect
						label="Which email"
						options={found.map((email) => ({value: emailKey(email), label: emailLabel(email)}))}
						value={emailKey(picked)}
						onChange={setChosen}
					/>
				) : (
					<span className="min-w-0 truncate">
						{picked ? (
							emailLabel(picked)
						) : (
							<span className="text-muted-foreground">
								{emails.loading || !emails.data
									? 'Looking for the email…'
									: `No email ${described.join(' ')}`.trim()}
							</span>
						)}
					</span>
				)}
			</div>
			{picked && (
				<EmailText
					text={opened.loading ? null : ownText(opened.data?.values.body ?? '')}
					failed={!opened.loading && opened.error !== null}
				/>
			)}
			<Textarea
				aria-label="Reply"
				placeholder="Write your reply"
				rows={4}
				value={body}
				onChange={(event) => setBody(event.target.value)}
			/>
		</WidgetFrame>
	);
}

// What the email being answered says, without what it quotes of those before it, to read before
// replying; lines while it is opened.
function EmailText({text, failed}: {text: string | null; failed: boolean}) {
	if (failed) {
		return <p className="text-muted-foreground">Couldn’t open this email.</p>;
	}
	if (text === null) {
		return (
			<div className="flex flex-col gap-2 border-l-2 pl-3">
				<p className="sr-only">Opening the email…</p>
				<Skeleton aria-hidden className="h-4 w-5/6" />
				<Skeleton aria-hidden className="h-4 w-2/3" />
			</div>
		);
	}
	return (
		<blockquote
			aria-label="Email"
			className="max-h-48 overflow-y-auto border-l-2 pl-3 whitespace-pre-line text-muted-foreground"
		>
			{text || 'This email has no text.'}
		</blockquote>
	);
}
