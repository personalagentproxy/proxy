import type {Result} from 'ts-results-es';

import type {ApiError} from '@proxy/utils';
import type {Account, Calendar, CalendarEvent, FoundMeeting, MatchedFile, Transaction} from '@proxy/contracts/widgets';

import type {RecordTarget} from './connector';
import type {MailReply} from './email-reply';
import type {MailSearch} from './email-search';

/**
 * What a collection's connector does beyond listing, opening and writing its records, for the home
 * page's widgets: each capability belongs to one collection id, as `connectors.test.ts` checks, so
 * a widget works with every connector of the collection that has it, and an integration joins the
 * widget by its connector offering it. A widget adds which connection each answer is from. The
 * shapes the browser is shown are the schemas of `@proxy/contracts/widgets`.
 */

export type {Account, Calendar, CalendarEvent, MatchedFile, Transaction};

/** Where a file has the words searched for: in its name, or only inside it. */
export type Matched = MatchedFile['matched'];

/** Days as `2026-10-11`, both included. */
export type DayRange = {from: string; to: string};

/** The transactions between two days, newest first, the accounts they are on, and whether there were more than were read. */
export type Transactions = {accounts: Account[]; transactions: Transaction[]; more: boolean};

/** The calendars shown, and their events between two times. */
export type Agenda = {calendars: Calendar[]; events: CalendarEvent[]};

/** A meeting as a notetaker lists it, with what its notes say where they were read, else nothing. */
export type Meeting = Omit<FoundMeeting, 'connectionId'> & {notes: string};

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
