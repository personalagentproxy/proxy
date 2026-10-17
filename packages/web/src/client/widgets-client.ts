import {z} from 'zod';
import {apiRequest} from '@/client/request';

// The home page's widgets' reads and writes (`packages/api/src/widgets/`): every connection with
// the collection a widget is about, read at once, each answer saying which connections it read
// and which it couldn't.

const sourceSchema = z.object({
	connectionId: z.string(),
	integrationId: z.string(),
	account: z.string(),
	name: z.string().nullable(),
});

const failureSchema = z.object({
	connectionId: z.string(),
	account: z.string(),
	message: z.string(),
});

export type Source = z.infer<typeof sourceSchema>;
export type Failure = z.infer<typeof failureSchema>;

// A contact, or someone only in a mailbox's email, known by their name and address alone.
const personSchema = z.object({
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

const peopleSchema = z.object({
	sources: z.array(sourceSchema),
	people: z.array(z.object({name: z.string(), matches: z.array(personSchema)})),
	failed: z.array(failureSchema),
});

export type People = z.infer<typeof peopleSchema>;

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
export function findPeople(names: string[]) {
	return apiRequest('GET', `/api/widgets/people${query({name: names})}`, peopleSchema);
}

const calendarSchema = z.object({
	connectionId: z.string(),
	id: z.string(),
	name: z.string(),
	primary: z.boolean(),
	writable: z.boolean(),
	color: z.string().nullable(),
});

const agendaEventSchema = z.object({
	connectionId: z.string(),
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

const agendaSchema = z.object({
	sources: z.array(sourceSchema),
	calendars: z.array(calendarSchema),
	events: z.array(agendaEventSchema),
	target: z.object({connectionId: z.string(), calendarId: z.string()}).nullable(),
	failed: z.array(failureSchema),
});

export type AgendaCalendar = z.infer<typeof calendarSchema>;
export type AgendaEvent = z.infer<typeof agendaEventSchema>;
export type Agenda = z.infer<typeof agendaSchema>;

/** Every calendar's events between two times, and the calendars a new event can go in. */
export function getAgenda(from: Date, to: Date) {
	return apiRequest(
		'GET',
		`/api/widgets/agenda${query({from: from.toISOString(), to: to.toISOString()})}`,
		agendaSchema,
	);
}

const foundEventsSchema = z.object({
	sources: z.array(sourceSchema),
	events: z.array(agendaEventSchema),
	failed: z.array(failureSchema),
});

export type FoundEvents = z.infer<typeof foundEventsSchema>;

export type EventSearch = {from: string; searches: string[]};

/** The events from a time on that any of the searches finds in every calendar, soonest first. */
export function findEvents(search: EventSearch) {
	return apiRequest(
		'GET',
		`/api/widgets/events${query({from: search.from, search: search.searches})}`,
		foundEventsSchema,
	);
}

export type NewEvent = {
	connectionId: string;
	calendarId: string;
	title: string;
	start: string;
	end: string;
	location: string;
	guests: string[];
};

const madeEventSchema = z.object({title: z.string(), link: z.string().nullable()});

/** Makes the event; the calendar's provider invites its guests. */
export function createEvent(event: NewEvent) {
	return apiRequest('POST', '/api/widgets/events', madeEventSchema, event);
}

/** What changes of an event: only what is given, guests as they are to be once it is changed. */
export type EventChange = {
	connectionId: string;
	calendarId: string;
	eventId: string;
	title?: string;
	start?: string;
	end?: string;
	location?: string;
	guests?: string[];
};

/** Changes an event the person organizes, its guests told. */
export function editEvent(change: EventChange) {
	return apiRequest('PUT', '/api/widgets/events', madeEventSchema, change);
}

const foundEmailSchema = z.object({
	connectionId: z.string(),
	id: z.string(),
	from: z.string(),
	subject: z.string(),
	date: z.string(),
	unread: z.boolean(),
	link: z.string().nullable(),
});

const foundEmailsSchema = z.object({
	sources: z.array(sourceSchema),
	emails: z.array(foundEmailSchema),
	failed: z.array(failureSchema),
});

export type FoundEmail = z.infer<typeof foundEmailSchema>;
export type FoundEmails = z.infer<typeof foundEmailsSchema>;

// `words` are terms every one of which is searched for, each its words joined by " | ", any of which
// will do: "flight | itinerary | booking".
export type EmailQuery = {from: string | null; words: string[]; since: string | null};

/** The newest emails every mailbox finds: from someone, about the terms, since a day (2026-10-07). */
export function findEmails(search: EmailQuery) {
	return apiRequest(
		'GET',
		`/api/widgets/emails${query({from: search.from, words: search.words, since: search.since})}`,
		foundEmailsSchema,
	);
}

const mailboxesSchema = z.object({sources: z.array(sourceSchema), target: z.string().nullable()});

export type Mailboxes = z.infer<typeof mailboxesSchema>;

/** The mailboxes email can go out from, and the one last written from. */
export function getMailboxes() {
	return apiRequest('GET', '/api/widgets/mailboxes', mailboxesSchema);
}

export type NewEmail = {
	connectionId: string;
	to: string[];
	subject: string;
	body: string;
	send: boolean;
};

/** Sends the email, or saves it as a draft. */
export function writeEmail(email: NewEmail) {
	return apiRequest('POST', '/api/widgets/emails', z.object({sent: z.boolean()}), email);
}

const foundFileSchema = z.object({
	connectionId: z.string(),
	id: z.string(),
	name: z.string(),
	kind: z.string(),
	owner: z.string(),
	modified: z.string(),
	link: z.string().nullable(),
	// Where it has the words searched for: its name, or only inside it.
	matched: z.enum(['name', 'content']),
});

const foundFilesSchema = z.object({
	sources: z.array(sourceSchema),
	files: z.array(foundFileSchema),
	failed: z.array(failureSchema),
});

export type FoundFile = z.infer<typeof foundFileSchema>;
export type FoundFiles = z.infer<typeof foundFilesSchema>;

export type FileKind = 'Document' | 'Spreadsheet' | 'Presentation' | 'Folder';

export type FileQuery = {words: string[]; kind: FileKind | null; owner: string | null};

/** The files every file store finds: words of the name, a kind, an owner's address. */
export function findFiles(search: FileQuery) {
	return apiRequest(
		'GET',
		`/api/widgets/files${query({words: search.words, kind: search.kind, owner: search.owner})}`,
		foundFilesSchema,
	);
}

const ratesSchema = z.object({date: z.string(), rates: z.record(z.string(), z.number())});

export type DayRates = z.infer<typeof ratesSchema>;

/** What one euro is worth in each currency today, the European Central Bank's, by code. */
export function getRates() {
	return apiRequest('GET', '/api/widgets/rates', ratesSchema);
}
