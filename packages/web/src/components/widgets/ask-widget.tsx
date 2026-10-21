import {MessageCircleQuestionMarkIcon} from 'lucide-react';
import {useState} from 'react';
import type {Intent} from '@/client/intent-client';
import type {Answer, AskedCollection, Failure, Source} from '@/client/widgets-client';
import {buttonVariants} from '@proxy/ui/components/button';
import {Skeleton} from '@proxy/ui/components/skeleton';
import {IntegrationLogo} from '@/components/brand-logo';
import {ConnectWidget} from '@/components/widgets/connect-widget';
import {WidgetFrame} from '@/components/widgets/widget-frame';
import {WidgetSelect} from '@/components/widgets/widget-select';
import {findIntegration, type Integration} from '@/lib/integrations';
import {writeErrorMessage} from '@/lib/write-status';
import {
	useAddress,
	useAnswer,
	useEmails,
	useFiles,
	useMeetings,
	useRecords,
} from '@/lib/widget-lookups';
import {askSearch, senderName, shortDay, type AskIn, type AskSearch} from '@/lib/widget-values';

// A meeting, file, email, page or issue Ask can read, from any of its searches.
type Choice = {
	connectionId: string;
	collectionId: AskedCollection;
	id: string;
	title: string;
	// When it was, or was last changed, as a list shows it.
	when: string;
	link: string | null;
};

type Choices = {
	sources: Source[] | null;
	choices: Choice[];
	failed: Failure[];
	loading: boolean;
};

const NAME = 'Ask';

// What each place Ask looks in holds, one of them, and how a widget with none connected asks for one.
const PLACES: Record<AskIn, {kind: string; collectionIds: string[]; connect: string}> = {
	meetings: {
		kind: 'meeting',
		collectionIds: ['notes'],
		connect: 'Connect a meeting notetaker to ask about your meetings from here.',
	},
	documents: {
		kind: 'document',
		collectionIds: ['files', 'pages'],
		connect: 'Connect Google Drive or Notion to ask about your documents from here.',
	},
	emails: {
		kind: 'email',
		collectionIds: ['emails'],
		connect: 'Connect a mailbox to ask about your email from here.',
	},
	issues: {
		kind: 'issue',
		collectionIds: ['issues'],
		connect: 'Connect Linear to ask about your issues from here.',
	},
};

// A day as a list shows it, from a time the api sent; none when it can't be read.
function shortDayOf(time: string): string {
	const date = new Date(time);
	return Number.isNaN(date.getTime()) ? '' : shortDay(date);
}

// The meetings with everyone named, between the days said, those about the words first; null
// asks nothing, when Ask looks elsewhere.
function useMeetingChoices(search: AskSearch | null): Choices {
	const meetings = useMeetings(
		search && {
			from: search.days?.from ?? null,
			to: search.days?.to ?? null,
			with: search.people,
			words: search.words,
		},
	);
	return {
		sources: meetings.data?.sources ?? null,
		choices: (meetings.data?.meetings ?? []).map((meeting) => ({
			connectionId: meeting.connectionId,
			collectionId: 'notes',
			id: meeting.id,
			title: meeting.title,
			// "Sep 22, 2026 11:00 AM PDT" is "Sep 22".
			when: /^[A-Z][a-z]{2} \d{1,2}/.exec(meeting.date)?.[0] ?? meeting.date,
			link: meeting.link,
		})),
		failed: meetings.data?.failed ?? [],
		loading: meetings.loading,
	};
}

// The files named with the words, owned by the first person named, of the kind said first; null
// asks nothing, when Ask looks elsewhere.
function useFileChoices(search: AskSearch | null): Choices {
	const {address: owner, looking} = useAddress(search?.people[0] ?? null);
	const files = useFiles(
		search && !looking ? {words: search.words, kind: search.kind, owner} : null,
	);
	return {
		sources: files.data?.sources ?? null,
		// A folder has nothing to read.
		choices: (files.data?.files ?? [])
			.filter((file) => file.kind !== 'Folder')
			.map((file) => ({
				connectionId: file.connectionId,
				collectionId: 'files',
				id: file.id,
				title: file.name,
				when: shortDayOf(file.modified),
				link: file.link,
			})),
		failed: files.data?.failed ?? [],
		loading: looking || files.loading,
	};
}

// The emails from the first person named, with every word, since the first day said, newest
// first; null asks nothing, when Ask looks elsewhere.
function useEmailChoices(search: AskSearch | null): Choices {
	const emails = useEmails(
		search && {
			from: search.people[0] ?? null,
			words: search.words,
			since: search.days?.from ?? null,
		},
	);
	return {
		sources: emails.data?.sources ?? null,
		choices: (emails.data?.emails ?? []).map((email) => ({
			connectionId: email.connectionId,
			collectionId: 'emails',
			id: email.id,
			title: `${senderName(email.from)}: ${email.subject || 'No subject'}`,
			when: shortDayOf(email.date),
			link: email.link,
		})),
		failed: emails.data?.failed ?? [],
		loading: emails.loading,
	};
}

// What the collection's own search finds for the words, Notion's pages or Linear's issues, in its
// order; null asks nothing, when Ask looks elsewhere.
function useRecordChoices(collection: 'pages' | 'issues', search: AskSearch | null): Choices {
	const records = useRecords(search && {collection, words: search.words});
	return {
		sources: records.data?.sources ?? null,
		choices: (records.data?.records ?? []).map((record) => ({
			connectionId: record.connectionId,
			collectionId: collection,
			id: record.id,
			title: record.title,
			when: shortDayOf(record.updated),
			link: record.link,
		})),
		failed: records.data?.failed ?? [],
		loading: records.loading,
	};
}

/**
 * Two searches as one, once both have answered: those whose title has every word first, then as
 * each search ordered them, the first's before the second's.
 */
function together(first: Choices, second: Choices, words: string[]): Choices {
	const named = (choice: Choice) => {
		const title = choice.title.toLowerCase();
		return words.every((word) => title.includes(word)) ? 1 : 0;
	};
	return {
		sources: first.sources && second.sources ? [...first.sources, ...second.sources] : null,
		choices: [...first.choices, ...second.choices].sort((a, b) => named(b) - named(a)),
		failed: [...first.failed, ...second.failed],
		loading: first.loading || second.loading,
	};
}

function choiceKey(choice: Choice): string {
	return `${choice.connectionId} ${choice.id}`;
}

function choiceLabel(choice: Choice): string {
	return choice.when ? `${choice.title} · ${choice.when}` : choice.title;
}

// The integration it is in, and where it opens, as the catalog names it: "Granola", "Google Drive".
function whereFrom(
	sources: Source[],
	choice: Choice,
): {integration: Integration; openIn: string | null} | null {
	const integrationId = sources.find(
		(source) => source.connectionId === choice.connectionId,
	)?.integrationId;
	const integration = integrationId ? findIntegration(integrationId) : undefined;
	if (!integration) {
		return null;
	}
	const collection = integration.collections.find((one) => one.id === choice.collectionId);
	return {integration, openIn: collection?.openIn ?? null};
}

// Who it is with, from or by, as what was searched for says it.
const PEOPLE_WORDS: Record<AskIn, string | null> = {
	meetings: 'with',
	documents: 'by',
	emails: 'from',
	issues: null,
};

// What was searched for, in words: "with Sam about pricing".
function described(search: AskSearch): string {
	const people = PEOPLE_WORDS[search.in];
	const when = searchedWhen(search);
	return [
		...(people && search.people.length > 0 ? [`${people} ${search.people.join(' and ')}`] : []),
		...(search.words.length > 0 ? [`about ${search.words.join(' ')}`] : []),
		...(when ? [when] : []),
	].join(' ');
}

// A day sent to the api, 2026-10-14, as a list shows it: "Oct 14".
function dayRead(day: string): string {
	const [year = 0, month = 1, date = 1] = day.split('-').map(Number);
	return shortDay(new Date(year, month - 1, date));
}

// The days searched, as the line saying nothing was found ends: "on Oct 14", "since Oct 7", or,
// for meetings when no day was said, the last three months the api looks back over.
function searchedWhen({in: place, days}: AskSearch): string | null {
	if (days) {
		return days.from === days.to ? `on ${dayRead(days.from)}` : `since ${dayRead(days.from)}`;
	}
	return place === 'meetings' ? 'in the last 3 months' : null;
}

// Ask: the meeting, document, email or issue what was asked is about, found by its people, its
// name or topic and the days said, and what it says of the question, which the api answers from
// reading it whole. The one picked is shown above the answer, the others found to choose from,
// since an answer from the wrong meeting reads as well as one from the right one.
export function AskWidget({intent, typed, now}: {intent: Intent; typed: string; now: Date}) {
	const search = askSearch(intent, typed, now);
	const asked = (place: AskIn) => (search.in === place ? search : null);
	const meetings = useMeetingChoices(asked('meetings'));
	const files = useFileChoices(asked('documents'));
	const pages = useRecordChoices('pages', asked('documents'));
	const emails = useEmailChoices(asked('emails'));
	const issues = useRecordChoices('issues', asked('issues'));
	const found = {
		meetings,
		documents: together(files, pages, search.words),
		emails,
		issues,
	}[search.in];
	const [chosen, setChosen] = useState<string | null>(null);
	const picked =
		found.choices.find((choice) => choiceKey(choice) === chosen) ?? found.choices[0] ?? null;
	const answer = useAnswer(
		picked && {
			question: typed,
			connectionId: picked.connectionId,
			collectionId: picked.collectionId,
			id: picked.id,
		},
	);
	const place = PLACES[search.in];
	const kind = place.kind;

	if (found.sources && found.sources.length === 0) {
		return (
			<ConnectWidget
				icon={MessageCircleQuestionMarkIcon}
				name={NAME}
				collectionIds={place.collectionIds}
			>
				{place.connect}
			</ConnectWidget>
		);
	}

	const from = picked && whereFrom(found.sources ?? [], picked);
	return (
		<WidgetFrame
			icon={MessageCircleQuestionMarkIcon}
			name={NAME}
			failed={found.failed}
			actions={
				picked?.link &&
				from?.openIn && (
					<a
						href={picked.link}
						target="_blank"
						rel="noreferrer"
						className={buttonVariants({size: 'sm', variant: 'outline'})}
					>
						Open in {from.openIn}
					</a>
				)
			}
		>
			<div className="flex min-w-0 items-center gap-2">
				<span className="shrink-0 text-muted-foreground">From</span>
				{from && <IntegrationLogo integration={from.integration} />}
				{found.choices.length > 1 && picked ? (
					<WidgetSelect
						label={`Which ${kind}`}
						options={found.choices.map((choice) => ({
							value: choiceKey(choice),
							label: choiceLabel(choice),
						}))}
						value={choiceKey(picked)}
						onChange={setChosen}
					/>
				) : (
					<span className="min-w-0 truncate">
						{picked ? (
							choiceLabel(picked)
						) : (
							<span className="text-muted-foreground">
								{found.loading || !found.sources
									? `Looking for the ${kind}…`
									: `No ${kind} ${described(search)}`.trim()}
							</span>
						)}
					</span>
				)}
			</div>
			{picked && (
				<Answered
					answer={answer.loading ? null : answer.data}
					error={answer.loading || !answer.error ? null : writeErrorMessage(answer.error)}
				/>
			)}
		</WidgetFrame>
	);
}

// What it says, the passages it rests on below, or lines while it is read.
function Answered({answer, error}: {answer: Answer | null; error: string | null}) {
	if (error) {
		return <p className="text-destructive">{error}</p>;
	}
	if (!answer) {
		return (
			<div className="flex flex-col gap-2">
				<p className="sr-only">Reading…</p>
				<Skeleton aria-hidden className="h-4 w-full" />
				<Skeleton aria-hidden className="h-4 w-5/6" />
				<Skeleton aria-hidden className="h-4 w-2/3" />
			</div>
		);
	}
	return (
		<div className="flex flex-col gap-3">
			<p className={`whitespace-pre-line ${answer.found ? '' : 'text-muted-foreground'}`}>
				{answer.answer}
			</p>
			{answer.quotes.length > 0 && (
				<ul className="flex flex-col gap-2" aria-label="Quotes">
					{answer.quotes.map((quote) => (
						<li key={quote} className="border-l-2 pl-3 text-muted-foreground">
							“{quote}”
						</li>
					))}
				</ul>
			)}
			{answer.cut && (
				<p className="text-muted-foreground">It’s long, so only its beginning was read.</p>
			)}
		</div>
	);
}
