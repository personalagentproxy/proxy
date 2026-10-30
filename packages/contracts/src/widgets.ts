import {z} from 'zod';

/**
 * The home page's widgets' reads and writes (`packages/api/src/widgets/`, under
 * `/api/orgs/:org/widgets/`): every connection with the collection a widget is about, read at
 * once, each answer saying which connections it read and which it couldn't.
 */

/** What the browser is told of a source: which account it is, to tell several apart. */
export const sourceSummarySchema = z.object({
	connectionId: z.string(),
	integrationId: z.string(),
	account: z.string(),
	name: z.string().nullable(),
});

export type SourceSummary = z.infer<typeof sourceSummarySchema>;

/** A source that couldn't be read, and why, in a line the widget shows. */
export const failureSchema = z.object({
	connectionId: z.string(),
	account: z.string(),
	message: z.string(),
});

export type Failure = z.infer<typeof failureSchema>;

/**
 * A person: a contact, read from the `contacts` collection's fields, which every contact book
 * shares, or someone in a mailbox's email, known by their name and address alone.
 */
export const personSchema = z.object({
	/** Where they were found: a contact book, or the email of a mailbox. */
	origin: z.enum(['contacts', 'email']),
	connectionId: z.string(),
	id: z.string(),
	name: z.string(),
	emails: z.array(z.string()),
	phones: z.array(z.string()),
	company: z.string(),
	jobTitle: z.string(),
	addresses: z.array(z.string()),
	link: z.string().nullable(),
});

export type Person = z.infer<typeof personSchema>;

/** `GET widgets/people?name=…&name=…`: the people each name finds, the closest first. */
export const peopleSchema = z.object({
	sources: z.array(sourceSummarySchema),
	people: z.array(z.object({name: z.string(), matches: z.array(personSchema)})),
	failed: z.array(failureSchema),
});

export type People = z.infer<typeof peopleSchema>;

/** A calendar as the widgets show it, and whether a new event can go in it. */
export const calendarSchema = z.object({
	id: z.string(),
	name: z.string(),
	primary: z.boolean(),
	writable: z.boolean(),
	color: z.string().nullable(),
});

export type Calendar = z.infer<typeof calendarSchema>;

/** A calendar as the widget shows it: whose, and whether a new event can go in it. */
export const agendaCalendarSchema = calendarSchema.extend({connectionId: z.string()});

export type AgendaCalendar = z.infer<typeof agendaCalendarSchema>;

/**
 * An event of a calendar: its times with their offsets, or for an all-day event its first day and
 * the day after its last; where it is, everyone invited but the account itself and rooms, by
 * their addresses, and whether the person can change it, which they can only of an event they
 * organize, in a calendar they can write to.
 */
export const calendarEventSchema = z.object({
	calendarId: z.string(),
	id: z.string(),
	title: z.string(),
	start: z.string(),
	end: z.string(),
	allDay: z.boolean(),
	location: z.string(),
	guests: z.array(z.string()),
	editable: z.boolean(),
	link: z.string().nullable(),
});

export type CalendarEvent = z.infer<typeof calendarEventSchema>;

/** An event of a calendar, and whose. */
export const agendaEventSchema = calendarEventSchema.extend({connectionId: z.string()});

export type AgendaEvent = z.infer<typeof agendaEventSchema>;

/** The calendar a new event goes in. */
export const calendarTargetSchema = z.object({connectionId: z.string(), calendarId: z.string()});

export type CalendarTarget = z.infer<typeof calendarTargetSchema>;

/**
 * `GET widgets/agenda?from=…&to=…`: every calendar's events between two times, and the calendars
 * a new event can go in, with the one it goes in unless another is picked.
 */
export const agendaSchema = z.object({
	sources: z.array(sourceSummarySchema),
	calendars: z.array(agendaCalendarSchema),
	events: z.array(agendaEventSchema),
	target: calendarTargetSchema.nullable(),
	failed: z.array(failureSchema),
});

export type Agenda = z.infer<typeof agendaSchema>;

/** `GET widgets/events?from=…&search=…`: the events from a time on that any search finds, soonest first. */
export const foundEventsSchema = z.object({
	sources: z.array(sourceSummarySchema),
	events: z.array(agendaEventSchema),
	failed: z.array(failureSchema),
});

export type FoundEvents = z.infer<typeof foundEventsSchema>;

/** `POST widgets/events`: an event made in the calendar picked; the calendar's provider invites its guests. */
export const newEventBodySchema = z.object({
	connectionId: z.string().min(1),
	calendarId: z.string().min(1),
	title: z.string().trim().min(1).max(500),
	start: z.iso.datetime({offset: true}),
	end: z.iso.datetime({offset: true}),
	location: z.string().trim().max(500).default(''),
	guests: z.array(z.email()).max(100).default([]),
});

export type NewEvent = z.input<typeof newEventBodySchema>;

/**
 * `PUT widgets/events`: what changes of an event the person organizes, only what is given, its
 * guests told.
 */
export const eventChangeBodySchema = z.object({
	connectionId: z.string().min(1),
	calendarId: z.string().min(1),
	eventId: z.string().min(1),
	title: z.string().trim().min(1).max(500).optional(),
	start: z.iso.datetime({offset: true}).optional(),
	end: z.iso.datetime({offset: true}).optional(),
	location: z.string().trim().max(500).optional(),
	/** Everyone invited once it is changed, the account itself left out. */
	guests: z.array(z.email()).max(100).optional(),
});

export type EventChange = z.input<typeof eventChangeBodySchema>;

/** The answer to `POST` and `PUT widgets/events`: the event as it was made or changed. */
export const madeEventSchema = z.object({title: z.string(), link: z.string().nullable()});

export type MadeEvent = z.infer<typeof madeEventSchema>;

export const foundEmailSchema = z.object({
	connectionId: z.string(),
	id: z.string(),
	from: z.string(),
	subject: z.string(),
	date: z.string(),
	unread: z.boolean(),
	link: z.string().nullable(),
});

export type FoundEmail = z.infer<typeof foundEmailSchema>;

/** `GET widgets/emails?from=…&words=…&since=…`: the newest emails every mailbox finds. */
export const foundEmailsSchema = z.object({
	sources: z.array(sourceSummarySchema),
	emails: z.array(foundEmailSchema),
	failed: z.array(failureSchema),
});

export type FoundEmails = z.infer<typeof foundEmailsSchema>;

/** `GET widgets/mailboxes`: the mailboxes email can go out from, and the one last written from. */
export const mailboxesSchema = z.object({
	sources: z.array(sourceSummarySchema),
	target: z.string().nullable(),
});

export type Mailboxes = z.infer<typeof mailboxesSchema>;

/** `POST widgets/emails`: an email from the mailbox picked, sent or saved as a draft. */
export const newEmailBodySchema = z.object({
	connectionId: z.string().min(1),
	to: z.array(z.email()).min(1).max(100),
	subject: z.string().trim().max(1000).default(''),
	body: z.string().max(100_000).default(''),
	/** Sent at once, or saved as a draft. */
	send: z.boolean(),
});

export type NewEmail = z.input<typeof newEmailBodySchema>;

/** `POST widgets/emails/reply`: a reply to an email found, in its thread, sent or saved as a draft. */
export const emailReplyBodySchema = z.object({
	/** The mailbox the email was found in, which the reply goes out from. */
	connectionId: z.string().min(1),
	/** The email answered, as the search found it. */
	emailId: z.string().min(1).max(500),
	body: z.string().max(100_000),
	/** Sent at once, or saved as a draft. */
	send: z.boolean(),
});

export type EmailReply = z.input<typeof emailReplyBodySchema>;

/** The answer to `POST widgets/emails` and `widgets/emails/reply`. */
export const writtenEmailSchema = z.object({sent: z.boolean()});

export type WrittenEmail = z.infer<typeof writtenEmailSchema>;

/** The kinds of file a search prefers. */
export const FILE_KINDS = ['Document', 'Spreadsheet', 'Presentation', 'Folder'] as const;

export type FileKind = (typeof FILE_KINDS)[number];

/** A file a search found. */
export const matchedFileSchema = z.object({
	id: z.string(),
	name: z.string(),
	kind: z.string(),
	owner: z.string(),
	modified: z.string(),
	link: z.string().nullable(),
	/** Where it has the words searched for: its name, or only inside it. */
	matched: z.enum(['name', 'content']),
});

export type MatchedFile = z.infer<typeof matchedFileSchema>;

export const foundFileSchema = matchedFileSchema.extend({connectionId: z.string()});

export type FoundFile = z.infer<typeof foundFileSchema>;

/** `GET widgets/files?words=…&kind=…&owner=…`: the files every file store finds. */
export const foundFilesSchema = z.object({
	sources: z.array(sourceSummarySchema),
	files: z.array(foundFileSchema),
	failed: z.array(failureSchema),
});

export type FoundFiles = z.infer<typeof foundFilesSchema>;

export const foundMeetingSchema = z.object({
	connectionId: z.string(),
	id: z.string(),
	title: z.string(),
	/** As the notetaker writes it: "Sep 22, 2026 11:00 AM PDT". */
	date: z.string(),
	participants: z.string(),
	link: z.string().nullable(),
});

export type FoundMeeting = z.infer<typeof foundMeetingSchema>;

/** `GET widgets/meetings?from=…&to=…&with=…&words=…`: the meetings every notetaker finds. */
export const foundMeetingsSchema = z.object({
	sources: z.array(sourceSummarySchema),
	meetings: z.array(foundMeetingSchema),
	failed: z.array(failureSchema),
});

export type FoundMeetings = z.infer<typeof foundMeetingsSchema>;

/** The collections searched as an agent searches them: Notion's pages, Linear's issues. */
export const SEARCHED_COLLECTIONS = ['pages', 'issues'] as const;

export type SearchedCollection = (typeof SEARCHED_COLLECTIONS)[number];

export const foundRecordSchema = z.object({
	connectionId: z.string(),
	id: z.string(),
	title: z.string(),
	updated: z.string(),
	link: z.string().nullable(),
});

export type FoundRecord = z.infer<typeof foundRecordSchema>;

/** `GET widgets/records?collection=…&words=…`: what every source's own search finds, in its order. */
export const foundRecordsSchema = z.object({
	sources: z.array(sourceSummarySchema),
	records: z.array(foundRecordSchema),
	failed: z.array(failureSchema),
});

export type FoundRecords = z.infer<typeof foundRecordsSchema>;

/** What Ask reads, by the collection the catalog names: a meeting's notes, a file, an email, a page or an issue. */
export const ASKED_COLLECTIONS = ['notes', 'files', 'emails', 'pages', 'issues'] as const;

export type AskedCollection = (typeof ASKED_COLLECTIONS)[number];

/** `POST widgets/answer`: a question of one meeting, file, email, page or issue. */
export const askBodySchema = z.object({
	question: z.string().trim().min(1).max(500),
	connectionId: z.string().min(1),
	collectionId: z.enum(ASKED_COLLECTIONS),
	id: z.string().min(1).max(300),
});

export type AskQuery = z.input<typeof askBodySchema>;

/** The answer to `POST widgets/answer`: what the meeting, file, email, page or issue says of the question, read whole. */
export const answerSchema = z.object({
	title: z.string(),
	link: z.string().nullable(),
	/** Whether it says what was asked. */
	found: z.boolean(),
	answer: z.string(),
	/** Passages of it, word for word, the answer rests on. */
	quotes: z.array(z.string()),
	/** Whether it was longer than was read. */
	cut: z.boolean(),
});

export type Answer = z.infer<typeof answerSchema>;

/** `GET widgets/rates`: what one euro is worth in each currency, by code, and the day the European Central Bank published it. */
export const dayRatesSchema = z.object({date: z.string(), rates: z.record(z.string(), z.number())});

export type DayRates = z.infer<typeof dayRatesSchema>;

/** An account as the Balances widget shows it: what kind, and what it holds or owes. */
export const accountSchema = z.object({
	id: z.string(),
	name: z.string(),
	/** "Checking", "Credit card", "Mortgage". */
	type: z.string(),
	/** The account number's last digits, "0000", or nothing. */
	mask: z.string(),
	/** A card or a loan: its balance is what is owed. */
	owed: z.boolean(),
	balance: z.number().nullable(),
	available: z.number().nullable(),
	limit: z.number().nullable(),
	/** The ISO code, or a bank's own for a currency without one. */
	currency: z.string(),
});

export type Account = z.infer<typeof accountSchema>;

/** An account as the widgets show it: whose, what kind, and what it holds or owes. */
export const bankAccountSchema = accountSchema.extend({connectionId: z.string()});

export type BankAccount = z.infer<typeof bankAccountSchema>;

/** `GET widgets/accounts`: every bank's accounts with their balances. */
export const bankAccountsSchema = z.object({
	sources: z.array(sourceSummarySchema),
	accounts: z.array(bankAccountSchema),
	failed: z.array(failureSchema),
});

export type BankAccounts = z.infer<typeof bankAccountsSchema>;

/** A transaction as a statement signs it: money out of an account negative, money in positive. */
export const transactionSchema = z.object({
	accountId: z.string(),
	id: z.string(),
	/** The day, `2026-10-11`. */
	date: z.string(),
	/** The bank's own description. */
	name: z.string(),
	/** The merchant, where the integration knows it. */
	merchant: z.string().nullable(),
	amount: z.number(),
	currency: z.string(),
	/** One of `TRANSACTION_CATEGORIES`' ids, or none. */
	category: z.string().nullable(),
	pending: z.boolean(),
});

export type Transaction = z.infer<typeof transactionSchema>;

export const bankTransactionSchema = transactionSchema.extend({connectionId: z.string()});

export type BankTransaction = z.infer<typeof bankTransactionSchema>;

/** `GET widgets/transactions?from=…&to=…`: every bank's transactions between two days, newest first, with the accounts they are on. */
export const bankTransactionsSchema = z.object({
	sources: z.array(sourceSummarySchema),
	accounts: z.array(bankAccountSchema),
	transactions: z.array(bankTransactionSchema),
	/** Whether a bank had more than were read. */
	more: z.boolean(),
	failed: z.array(failureSchema),
});

export type BankTransactions = z.infer<typeof bankTransactionsSchema>;
