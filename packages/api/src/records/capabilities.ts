import type {Result} from 'ts-results-es';

import type {ApiError} from '@proxy/utils';

import type {RecordTarget} from './connector';
import type {MailReply} from './email-reply';
import type {MailSearch} from './email-search';

/**
 * What a collection's connector does beyond listing, opening and writing its records, for the home
 * page's widgets: each capability belongs to one collection id, as `connectors.test.ts` checks, so
 * a widget works with every connector of the collection that has it, and an integration joins the
 * widget by its connector offering it. A widget adds which connection each answer is from.
 */

/** An account as the Balances widget shows it: what kind, and what it holds or owes. */
export type Account = {
	id: string;
	name: string;
	/** "Checking", "Credit card", "Mortgage". */
	type: string;
	/** The account number's last digits, "0000", or nothing. */
	mask: string;
	/** A card or a loan: its balance is what is owed. */
	owed: boolean;
	balance: number | null;
	available: number | null;
	limit: number | null;
	/** The ISO code, or a bank's own for a currency without one. */
	currency: string;
};

/** A transaction as a statement signs it: money out of an account negative, money in positive. */
export type Transaction = {
	accountId: string;
	id: string;
	/** The day, `2026-10-11`. */
	date: string;
	/** The bank's own description. */
	name: string;
	/** The merchant, where the integration knows it. */
	merchant: string | null;
	amount: number;
	currency: string;
	/** One of `TRANSACTION_CATEGORIES`' ids, or none. */
	category: string | null;
	pending: boolean;
};

/** Days as `2026-10-11`, both included. */
export type DayRange = {from: string; to: string};

/** The transactions between two days, newest first, the accounts they are on, and whether there were more than were read. */
export type Transactions = {accounts: Account[]; transactions: Transaction[]; more: boolean};

/** A calendar as the widgets show it, and whether a new event can go in it. */
export type Calendar = {id: string; name: string; primary: boolean; writable: boolean; color: string | null};

/**
 * An event of a calendar: its times with their offsets, or for an all-day event its first day and
 * the day after its last; where it is, everyone invited but the account itself and rooms, by
 * their addresses, and whether the person can change it, which they can only of an event they
 * organize, in a calendar they can write to.
 */
export type CalendarEvent = {
	calendarId: string;
	id: string;
	title: string;
	start: string;
	end: string;
	allDay: boolean;
	location: string;
	guests: string[];
	editable: boolean;
	link: string | null;
};

/** The calendars shown, and their events between two times. */
export type Agenda = {calendars: Calendar[]; events: CalendarEvent[]};

/** A meeting as a notetaker lists it, with what its notes say where they were read, else nothing. */
export type Meeting = {
	id: string;
	title: string;
	// As the notetaker writes it: "Sep 22, 2026 11:00 AM PDT".
	date: string;
	participants: string;
	link: string | null;
	notes: string;
};

/**
 * A notetaker's meetings: those between two days, both included, newest first, and those with the
 * ids, their notes read, which a list may leave out.
 */
export type MeetingFinder = {
	between: (target: RecordTarget, from: string, to: string) => Promise<Result<Meeting[], ApiError>>;
	withNotes: (target: RecordTarget, meetingIds: string[]) => Promise<Result<Meeting[], ApiError>>;
};

/** A search for files: words of the name, or of the text where no name has them, and an owner's address. */
export type FileSearch = {words: string[]; owner: string | null};

/** Where a file has the words searched for: in its name, or only inside it. */
export type Matched = 'name' | 'content';

export type MatchedFile = {id: string; name: string; kind: string; owner: string; modified: string; link: string | null; matched: Matched};

/** A record as a model reads it, its title and link to show beside the answer; no text when it has none to read. */
export type Reading = {title: string; link: string | null; text: string};

export type Capabilities = {
	/** `emails`: several searches over one sign-in, as `MailSearch` says. */
	findEmails?: MailSearch;
	/** `emails`: a reply to one, in its thread, which the `replies` collection's commands write too. */
	reply?: MailReply;
	/** `accounts`: every account with its balances. */
	balances?: (target: RecordTarget) => Promise<Result<Account[], ApiError>>;
	/** `transactions`: every account's transactions between two days. */
	transactionsBetween?: (target: RecordTarget, range: DayRange) => Promise<Result<Transactions, ApiError>>;
	/** `events`: the calendars shown and their events between two times. */
	agenda?: (target: RecordTarget, range: {from: string; to: string}) => Promise<Result<Agenda, ApiError>>;
	/** `events`: the events from a time on that any of the searches finds, soonest first, each once. */
	findEvents?: (target: RecordTarget, query: {from: string; searches: string[]}) => Promise<Result<CalendarEvent[], ApiError>>;
	/** `notes`: the meetings of some days, and their notes. */
	meetings?: MeetingFinder;
	/** `files`: the files a search finds, at most `limit` where it searches inside them. */
	findFiles?: (target: RecordTarget, search: FileSearch, limit: number) => Promise<Result<MatchedFile[], ApiError>>;
	/**
	 * Any collection: a record read whole as text, where its fields alone don't say it all, as a
	 * meeting's transcript is another collection's. `readable` says which of the integration's
	 * collections the sign-in covers reading.
	 */
	readText?: (target: RecordTarget, recordId: string, readable: (collectionId: string) => boolean) => Promise<Result<Reading, ApiError>>;
};

export type Capability = keyof Capabilities;
