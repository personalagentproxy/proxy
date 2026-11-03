import {
	agendaSchema,
	answerSchema,
	bankAccountsSchema,
	bankTransactionsSchema,
	dayRatesSchema,
	foundEmailsSchema,
	foundEventsSchema,
	foundFilesSchema,
	foundMeetingsSchema,
	foundRecordsSchema,
	madeEventSchema,
	mailboxesSchema,
	peopleSchema,
	writtenEmailSchema,
	type AskQuery,
	type EmailReply,
	type EventChange,
	type FileKind,
	type NewEmail,
	type NewEvent,
	type SearchedCollection,
} from '@proxy/contracts/widgets';
import {apiRequest, orgApi} from '@/client/request';

// The home page's widgets' reads and writes (`packages/api/src/widgets/`): every connection with
// the collection a widget is about, read at once, each answer saying which connections it read
// and which it couldn't. What they answer and take is `@proxy/contracts/widgets`.

export type {
	Agenda,
	AgendaEvent,
	Answer,
	AskedCollection,
	BankAccount,
	BankTransaction,
	EventChange,
	Failure,
	FileKind,
	FoundEmail,
	People,
	Person,
	SourceSummary as Source,
} from '@proxy/contracts/widgets';

function query(params: Record<string, string | string[] | null>): string {
	const search = new URLSearchParams();
	for (const [key, value] of Object.entries(params)) {
		for (const one of value === null ? [] : Array.isArray(value) ? value : [value]) {
			search.append(key, one);
		}
	}
	return search.size > 0 ? `?${search.toString()}` : '';
}

/** The people each name finds in every contact book, the closest first. */
export function findPeople(org: string, names: string[]) {
	return apiRequest('GET', `${orgApi(org)}/widgets/people${query({name: names})}`, peopleSchema);
}

/** Every calendar's events between two times, and the calendars a new event can go in. */
export function getAgenda(org: string, from: Date, to: Date) {
	return apiRequest(
		'GET',
		`${orgApi(org)}/widgets/agenda${query({from: from.toISOString(), to: to.toISOString()})}`,
		agendaSchema,
	);
}

type EventSearch = {from: string; searches: string[]};

/** The events from a time on that any of the searches finds in every calendar, soonest first. */
export function findEvents(org: string, search: EventSearch) {
	return apiRequest(
		'GET',
		`${orgApi(org)}/widgets/events${query({from: search.from, search: search.searches})}`,
		foundEventsSchema,
	);
}

/** Makes the event; the calendar's provider invites its guests. */
export function createEvent(org: string, event: NewEvent) {
	return apiRequest('POST', `${orgApi(org)}/widgets/events`, madeEventSchema, event);
}

/** Changes an event the person organizes, its guests told. */
export function editEvent(org: string, change: EventChange) {
	return apiRequest('PUT', `${orgApi(org)}/widgets/events`, madeEventSchema, change);
}

// `words` are terms every one of which is searched for, each its words joined by " | ", any of which
// will do: "flight | itinerary | booking".
export type EmailQuery = {from: string | null; words: string[]; since: string | null};

/** The newest emails every mailbox finds: from someone, about the terms, since a day (2026-10-07). */
export function findEmails(org: string, search: EmailQuery) {
	return apiRequest(
		'GET',
		`${orgApi(org)}/widgets/emails${query({from: search.from, words: search.words, since: search.since})}`,
		foundEmailsSchema,
	);
}

/** The mailboxes email can go out from, and the one last written from. */
export function getMailboxes(org: string) {
	return apiRequest('GET', `${orgApi(org)}/widgets/mailboxes`, mailboxesSchema);
}

/** Sends the email, or saves it as a draft. */
export function writeEmail(org: string, email: NewEmail) {
	return apiRequest('POST', `${orgApi(org)}/widgets/emails`, writtenEmailSchema, email);
}

/** Sends a reply to the email, in its thread, or saves it as a draft. */
export function replyToEmail(org: string, reply: EmailReply) {
	return apiRequest('POST', `${orgApi(org)}/widgets/emails/reply`, writtenEmailSchema, reply);
}

type FileQuery = {words: string[]; kind: FileKind | null; owner: string | null};

/** The files every file store finds: words of the name, a kind, an owner's address. */
export function findFiles(org: string, search: FileQuery) {
	return apiRequest(
		'GET',
		`${orgApi(org)}/widgets/files${query({words: search.words, kind: search.kind, owner: search.owner})}`,
		foundFilesSchema,
	);
}

// Days as 2026-10-14, both included, the last three months when not given; people by name or address.
type MeetingQuery = {
	from: string | null;
	to: string | null;
	with: string[];
	words: string[];
};

/** The meetings every notetaker has between two days with every person, those about the words first. */
export function findMeetings(org: string, search: MeetingQuery) {
	return apiRequest(
		'GET',
		`${orgApi(org)}/widgets/meetings${query({from: search.from, to: search.to, with: search.with, words: search.words})}`,
		foundMeetingsSchema,
	);
}

/** A collection searched as an agent searches it: Notion's pages, Linear's issues. */
type RecordQuery = {collection: SearchedCollection; words: string[]};

/** What every source's own search finds in the collection for the words, in its order. */
export function findRecords(org: string, search: RecordQuery) {
	return apiRequest(
		'GET',
		`${orgApi(org)}/widgets/records${query({collection: search.collection, words: search.words})}`,
		foundRecordsSchema,
	);
}

/** What the meeting, file, email, page or issue says of the question, read whole. */
export function askAbout(org: string, ask: AskQuery) {
	return apiRequest('POST', `${orgApi(org)}/widgets/answer`, answerSchema, ask);
}

/** What one euro is worth in each currency today, the European Central Bank's, by code. */
export function getRates(org: string) {
	return apiRequest('GET', `${orgApi(org)}/widgets/rates`, dayRatesSchema);
}

/** Every bank's accounts with their balances. */
export function getAccounts(org: string) {
	return apiRequest('GET', `${orgApi(org)}/widgets/accounts`, bankAccountsSchema);
}

/** Two days, both included, as 2026-09-01. */
export type DayRange = {from: string; to: string};

/** Every bank's transactions between two days, newest first, with the accounts they are on. */
export function findTransactions(org: string, range: DayRange) {
	return apiRequest(
		'GET',
		`${orgApi(org)}/widgets/transactions${query({from: range.from, to: range.to})}`,
		bankTransactionsSchema,
	);
}
