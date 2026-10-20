import {MailIcon} from 'lucide-react';
import {useState} from 'react';
import type {Intent} from '@/client/intent-client';
import {writeEmail} from '@/client/widgets-client';
import {Badge} from '@proxy/ui/components/badge';
import {Button} from '@proxy/ui/components/button';
import {Input} from '@proxy/ui/components/input';
import {Textarea} from '@proxy/ui/components/textarea';
import {ConnectWidget} from '@/components/widgets/connect-widget';
import {Missing, WidgetFrame} from '@/components/widgets/widget-frame';
import {WidgetSelect} from '@/components/widgets/widget-select';
import {WriteResult} from '@/components/widgets/write-result';
import {useSuggested} from '@/lib/use-suggested';
import {useMailboxes, usePeople} from '@/lib/widget-lookups';
import {aboutPhrase, bestMatch, fieldTexts, isAddress, namesIn} from '@/lib/widget-values';
import {useWriteStatus, writeErrorMessage} from '@/lib/write-status';

// Write email: the recipients found among the contacts, the subject, and a body to write, sent
// or saved as a draft from the mailbox picked, the one last written from first.
export function WriteEmailWidget({intent, typed}: {intent: Intent; typed: string}) {
	const names = namesIn(intent, 'to');
	const people = usePeople(names.length > 0 ? names : null);
	const mailboxes = useMailboxes(true);
	const [picked, setPicked] = useState<string | null>(null);
	const [subject, setSubject] = useSuggested(
		fieldTexts(intent, 'subject')[0] ?? aboutPhrase(typed) ?? '',
	);
	const [body, setBody] = useSuggested(fieldTexts(intent, 'body')[0] ?? '');
	const [status, setStatus] = useWriteStatus(typed);
	const recipients = names.map((name) => {
		const person = isAddress(name) ? null : bestMatch(people.data, name);
		return {name, person, address: isAddress(name) ? name : (person?.emails[0] ?? null)};
	});

	if (mailboxes.data?.sources.length === 0) {
		return (
			<ConnectWidget icon={MailIcon} name="Write email" collectionIds={['emails']}>
				Connect a mailbox to write and send email from here.
			</ConnectWidget>
		);
	}

	const sources = mailboxes.data?.sources ?? [];
	const from =
		sources.find((source) => source.connectionId === picked) ??
		sources.find((source) => source.connectionId === mailboxes.data?.target) ??
		null;
	const to = recipients.flatMap((recipient) => (recipient.address ? [recipient.address] : []));
	const busy = status.kind === 'saving' || status.kind === 'done';

	const write = (send: boolean) => {
		if (!from || to.length === 0) {
			return;
		}
		setStatus({kind: 'saving'});
		void writeEmail({connectionId: from.connectionId, to, subject, body, send}).then((result) => {
			if (result.isErr()) {
				setStatus({kind: 'failed', message: writeErrorMessage(result.error)});
				return;
			}
			setStatus({kind: 'done', message: send ? 'Sent' : 'Saved as a draft', link: null});
		});
	};

	return (
		<WidgetFrame
			icon={MailIcon}
			name="Write email"
			status={<WriteResult status={status} />}
			actions={
				<>
					<Button
						size="sm"
						variant="outline"
						onClick={() => write(false)}
						disabled={!from || to.length === 0 || busy}
					>
						Save draft
					</Button>
					<Button size="sm" onClick={() => write(true)} disabled={!from || to.length === 0 || busy}>
						Send
					</Button>
				</>
			}
		>
			{sources.length > 1 && (
				<div className="flex min-w-0 items-center gap-2">
					<span className="text-muted-foreground">From</span>
					<WidgetSelect
						label="From"
						options={sources.map((source) => ({value: source.connectionId, label: source.account}))}
						value={from?.connectionId ?? null}
						onChange={setPicked}
					/>
				</div>
			)}
			<div className="flex min-h-9 flex-wrap items-center gap-2" aria-label="To">
				<span className="text-muted-foreground">To</span>
				{recipients.length === 0 && <Missing>No one yet</Missing>}
				{recipients.map((recipient) => (
					<Badge key={recipient.name} variant="outline">
						{recipient.person?.name ?? recipient.name}
						<span className="font-normal text-muted-foreground">
							{recipient.address ?? (people.loading ? 'looking…' : 'no address')}
						</span>
					</Badge>
				))}
			</div>
			<Input
				aria-label="Subject"
				placeholder="Subject"
				value={subject}
				onChange={(event) => setSubject(event.target.value)}
			/>
			<Textarea
				aria-label="Message"
				placeholder="Write your message"
				rows={4}
				value={body}
				onChange={(event) => setBody(event.target.value)}
			/>
		</WidgetFrame>
	);
}
