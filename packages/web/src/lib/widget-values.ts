import * as chrono from 'chrono-node';
import {dayIn} from '@proxy/utils/days';
import type {Intent} from '@/client/intent-client';
import type {EmailQuery, FileKind, People, Person} from '@/client/widgets-client';
import {browserTimeZone} from '@/lib/activity-graph';

// What the home page's widgets make of the fields the api filled: the people names stand for,
// times read as dates, and what to search mailboxes and file stores for.

const DEFAULT_MEETING_MINUTES = 30;
// The hour a meeting goes at when only its day was said.
const DEFAULT_MEETING_HOUR = 10;

/** What fills one of the picked widget's fields: its value, or each of a list's. */
export function fieldTexts(intent: Intent, fieldId: string): string[] {
	return intent.fields.find((candidate) => candidate.id === fieldId)?.values ?? [];
}

/**
 * The people a field names, one each: a model takes "jon and jacky" for one at times, so a name is
 * parted where "and", "&" or a comma joins two.
 */
export function namesIn(intent: Intent, fieldId: string): string[] {
	return fieldTexts(intent, fieldId)
		.flatMap((text) => text.split(/\s*(?:,|&|\band\b)\s*/i))
		.map((name) => name.trim())
		.filter((name) => name !== '');
}

/**
 * What an email is about, where the model found no subject: what follows "about" in all that was
 * typed, "lunch next week" of "email jon about lunch next week".
 */
export function aboutPhrase(typed: string): string | null {
	const [, phrase] = /\b(?:about|re|regarding)\s+(.+)$/i.exec(typed.trim()) ?? [];
	return phrase?.trim() || null;
}

/** Everyone a name found in the contact books, the closest first. */
export function matchesFor(people: People | null, name: string): Person[] {
	return people?.people.find((found) => found.name === name.trim())?.matches ?? [];
}

/** The person a name stands for: the closest the contact books found, if any. */
export function bestMatch(people: People | null, name: string): Person | null {
	return matchesFor(people, name)[0] ?? null;
}

/** One person among those found, the same in every lookup: their contact book and their id in it. */
export function personKey(person: Person): string {
	return `${person.connectionId} ${person.id}`;
}

/** Whether a name as typed is an address already, which needs no contact. */
export function isAddress(text: string): boolean {
	return /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(text.trim());
}

export function initials(name: string): string {
	return name
		.split(/\s+/)
		.filter((part) => part !== '')
		.slice(0, 2)
		.map((part) => part[0]?.toUpperCase() ?? '')
		.join('');
}

const SHORT_DAY = new Intl.DateTimeFormat(undefined, {month: 'short', day: 'numeric'});

/** A day as a list shows it: "Oct 11". */
export function shortDay(date: Date): string {
	return SHORT_DAY.format(date);
}

export type EventTime = {
	start: Date;
	end: Date;
	/** Only the day was said, so the hour is a suggestion. */
	hourGuessed: boolean;
};

// An hour said without am or pm, from 1 to 7, is in the afternoon: "at 2" is 2 PM, since meetings
// at 2 AM are rare. From 8 to 12 it is as said.
const LAST_AFTERNOON_GUESS = 7;

function afternoonGuess(component: chrono.ParsedComponents, date: Date): Date {
	const hour = date.getHours();
	if (component.isCertain('meridiem') || hour < 1 || hour > LAST_AFTERNOON_GUESS) {
		return date;
	}
	return new Date(date.getTime() + 12 * 3_600_000);
}

function withTimeOf(day: Date, time: Date): Date {
	const date = new Date(day);
	date.setHours(time.getHours(), time.getMinutes(), 0, 0);
	return date;
}

// "an hour later", "30 minutes earlier", "push it back by half an hour": how far an event moves
// from where it is, in milliseconds, later positive; null when that isn't what was said.
const SHIFTS = [
	/\b(\d+(?:\.\d+)?|an?|half an?)\s*(hours?|hrs?|minutes?|mins?)\s+(later|earlier|sooner|back)\b/i,
	/\b(later|earlier|sooner|back)\s+(?:by\s+)?(\d+(?:\.\d+)?|an?|half an?)\s*(hours?|hrs?|minutes?|mins?)\b/i,
];

function shiftOf(said: string): number | null {
	for (const [index, pattern] of SHIFTS.entries()) {
		const match = pattern.exec(said);
		if (!match) {
			continue;
		}
		const [amount = '', unit = '', direction = ''] =
			index === 0 ? [match[1], match[2], match[3]] : [match[2], match[3], match[1]];
		const count = /^half/i.test(amount) ? 0.5 : /^an?$/i.test(amount) ? 1 : Number(amount);
		const ms = count * (/^h/i.test(unit) ? 3_600_000 : 60_000);
		return /^(earlier|sooner)$/i.test(direction) ? -ms : ms;
	}
	return null;
}

// A weekday said alone is the first from the event's own day on: a Tuesday meeting moved to
// "thursday" goes two days later, not to the Thursday before it. "Tomorrow" is from now.
function weekdayFirst(said: string, eventStart: Date, now: Date): chrono.ParsedResult[] {
	const results = chrono.parse(said, now, {forwardDate: true});
	const [first] = results;
	if (!first || !first.start.isCertain('weekday') || first.start.isCertain('day')) {
		return results;
	}
	const from = new Date(Math.max(eventStart.getTime(), now.getTime()));
	from.setHours(0, 0, 0, 0);
	return chrono.parse(said, from, {forwardDate: true});
}

/**
 * When an event moves to, from what was said of its new time: "an hour later" from where it is,
 * else the day and hour said, the rest as the event is ("10am" its own day, "thursday" its own
 * hour), its length kept unless an end is said. Null when no time can be read.
 */
export function movedTime(
	said: string,
	event: {start: Date; end: Date},
	now: Date,
): {start: Date; end: Date} | null {
	const length = event.end.getTime() - event.start.getTime();
	const shift = shiftOf(said);
	if (shift !== null) {
		const start = new Date(event.start.getTime() + shift);
		return {start, end: new Date(start.getTime() + length)};
	}
	const [first] = weekdayFirst(said, event.start, now);
	if (!first) {
		return null;
	}
	const daySaid = first.start.isCertain('day') || first.start.isCertain('weekday');
	const hourSaid = first.start.isCertain('hour');
	const start = withTimeOf(
		daySaid ? first.start.date() : event.start,
		hourSaid ? afternoonGuess(first.start, first.start.date()) : event.start,
	);
	const end =
		hourSaid && first.end ? withTimeOf(start, afternoonGuess(first.end, first.end.date())) : null;
	return {start, end: end && end > start ? end : new Date(start.getTime() + length)};
}

/**
 * When a meeting is, read from all that was typed with chrono-node: no field holds the time, and a
 * bare hour needs the "at" said before it. A day and an hour said apart ("on
 * friday about the launch at 3") are one time. A time without a day is the next one to come, a day
 * without a time is at 10:00, and a meeting without an end lasts half an hour.
 */
export function eventTime(typed: string, now: Date): EventTime | null {
	const results = chrono.parse(typed, now, {forwardDate: true});
	const [first] = results;
	if (!first) {
		return null;
	}

	const timed = results.find((result) => result.start.isCertain('hour'));
	const minutes = (date: Date) => new Date(date.getTime() + DEFAULT_MEETING_MINUTES * 60_000);
	if (!timed) {
		const start = first.start.date();
		start.setHours(DEFAULT_MEETING_HOUR, 0, 0, 0);
		return {start, end: minutes(start), hourGuessed: true};
	}

	// A day was said ("tomorrow", "friday"), or the hour is today's, and tomorrow's once it has passed:
	// "at 2" said at 3 in the afternoon. Today's, not chrono's, which moves "at 4" to tomorrow when
	// 4 AM has passed, before the hour is taken for the afternoon.
	const daySaid = first.start.isCertain('day') || first.start.isCertain('weekday');
	const start = withTimeOf(
		daySaid ? first.start.date() : now,
		afternoonGuess(timed.start, timed.start.date()),
	);
	if (!daySaid && start < now) {
		start.setDate(start.getDate() + 1);
	}
	const said = timed.end ? withTimeOf(start, afternoonGuess(timed.end, timed.end.date())) : null;
	return {start, end: said && said > start ? said : minutes(start), hourGuessed: false};
}

// A guest as the event widgets show them: the contact a name stands for, picked among those it
// found, or an address typed as it is.
export type Guest = {
	name: string;
	person: Person | null;
	address: string | null;
	matches: Person[];
};

export function guestsOf(
	names: string[],
	people: People | null,
	chosen: Record<string, string>,
): Guest[] {
	return names.map((name) => {
		if (isAddress(name)) {
			return {name, person: null, address: name, matches: []};
		}
		const matches = matchesFor(people, name);
		const person = matches.find((match) => personKey(match) === chosen[name]) ?? matches[0] ?? null;
		return {name, person, address: person?.emails[0] ?? null, matches};
	});
}

// The first word of an address, as "arne" is of arne.s@gmail.com.
function firstWord(address: string): string {
	return address.split('@')[0]?.split(/[._+-]/)[0] ?? '';
}

/**
 * The guests a name taken off an event means: its address, the addresses the contact it finds
 * has, or a guest's address whose first word it is, as "arne" is arne.s@gmail.com, and not
 * one only beginning with it, as "dan" isn't daniel@example.com.
 */
export function guestsNamed(guests: string[], name: string, people: People | null): string[] {
	const wanted = name.trim().toLowerCase();
	const addresses = (bestMatch(people, name)?.emails ?? []).map((email) => email.toLowerCase());
	return guests.filter((guest) => {
		const address = guest.toLowerCase();
		return address === wanted || addresses.includes(address) || firstWord(address) === wanted;
	});
}

/**
 * Who a name means on an event: the person it finds whose address is among the event's guests, as
 * "mike" is the Mike invited, not the first Mike the contacts and mailboxes have; null when none is.
 */
export function personOnEvent(
	people: People | null,
	name: string,
	guests: string[],
): Person | null {
	const invited = guests.map((guest) => guest.toLowerCase());
	return (
		matchesFor(people, name).find((person) =>
			person.emails.some((email) => invited.includes(email.toLowerCase())),
		) ?? null
	);
}

/** The day asked about, "today", "tomorrow" or the coming "friday", at its midnight; null when none is said. */
export function dayAsked(typed: string, now: Date): Date | null {
	const [first] = chrono.parse(typed, now, {forwardDate: true});
	if (!first) {
		return null;
	}
	const day = first.start.date();
	day.setHours(0, 0, 0, 0);
	return day;
}

/**
 * What to search the calendars for: the person the event is with, by the name written and the
 * addresses found for them, as an invite names its guests by either, each with what the event is
 * where that is said; or only what it is. At most three.
 */
export function eventSearches(
	{name, what}: {name: string | undefined; what: string | undefined},
	people: People | null,
): string[] {
	if (!name) {
		return what ? [what] : [];
	}
	const who = isAddress(name) ? [name] : [name, ...(bestMatch(people, name)?.emails ?? [])];
	return who.slice(0, 3).map((term) => (what ? `${what} ${term}` : term));
}

// A time of day alone ("the 3pm call") says nothing of when an email came.
function onlyTimeOfDay(result: chrono.ParsedResult): boolean {
	const {start} = result;
	return (
		start.isCertain('hour') &&
		!start.isCertain('day') &&
		!start.isCertain('weekday') &&
		!start.isCertain('month')
	);
}

// "friday's meeting" is what the email is about, not when it came.
function possessive(typed: string, result: chrono.ParsedResult): boolean {
	return /^['’]s\b/.test(typed.slice(result.index + result.text.length));
}

// The day a date said is, among those an email can have come on: "friday" or "december" alone
// are the last one, and a day still to come, as "tomorrow", none.
function pastDay(result: chrono.ParsedResult, today: Date): Date | null {
	const {start} = result;
	const day = start.date();
	day.setHours(0, 0, 0, 0);
	if (day <= today) {
		return day;
	}
	if (start.isCertain('weekday') && !start.isCertain('day')) {
		day.setDate(day.getDate() - 7);
		return day;
	}
	if (start.isCertain('month') && !start.isCertain('year')) {
		day.setFullYear(day.getFullYear() - 1);
		return day;
	}
	return null;
}

/**
 * The day a search for email goes back to, from what was typed: "last week", "yesterday", "since
 * monday". Dates that describe what the email is about rather than when it came are left out: a
 * day still to come ("my flight tomorrow"), a time of day alone, and one said as "friday's".
 */
function sinceDay(typed: string, now: Date): Date | null {
	const today = new Date(now);
	today.setHours(0, 0, 0, 0);
	for (const result of chrono.parse(typed, now)) {
		const day = onlyTimeOfDay(result) || possessive(typed, result) ? null : pastDay(result, today);
		if (day) {
			return day;
		}
	}
	return null;
}

/** Two days, both included, as 2026-10-14. */
export type Days = {from: string; to: string};

// A time said as a stretch of days, from when it began until now: "last week", "the past month".
const STRETCH = /\b(?:weeks?|months?|years?)\b/i;

/**
 * The days to look for a meeting in, from what was typed: the day said ("yesterday", "monday's",
 * "on oct 3", "this morning"), or from a time on until today ("last week", "since monday"). A day
 * still to come says nothing of a meeting had. Null when no time is said.
 */
export function meetingDays(typed: string, now: Date): Days | null {
	const today = new Date(now);
	today.setHours(0, 0, 0, 0);
	const zone = browserTimeZone();
	for (const result of chrono.parse(typed, now)) {
		const day = onlyTimeOfDay(result) ? null : pastDay(result, today);
		if (!day) {
			continue;
		}
		const stretch =
			STRETCH.test(result.text) || /\b(?:since|after)\s+$/i.test(typed.slice(0, result.index));
		return {from: dayIn(day, zone), to: dayIn(stretch ? today : day, zone)};
	}
	return null;
}

function words(text: string): string[] {
	return text
		.toLowerCase()
		.split(/[^\p{L}\p{N}]+/u)
		.filter((word) => word !== '');
}

// What a request for a file says around its name, left out of the search.
const FILLER = new Set(
	'a an the my our for of in on to me is are where wheres s find open show get pull up drive file files shared share sent called named that'.split(
		' ',
	),
);

/**
 * What to search the mailboxes for: from the sender as written, about the model's terms, each the
 * words any of which will do ("flight | itinerary | booking"), since the day said.
 */
export function emailQuery(intent: Intent, typed: string, now: Date): EmailQuery {
	const [from = null] = fieldTexts(intent, 'from');
	const since = sinceDay(typed, now);
	return {
		from,
		words: fieldTexts(intent, 'about'),
		since: since ? dayIn(since, browserTimeZone()) : null,
	};
}

/** The terms of a search as they read: the first of each one's words, "flight, SFO". */
export function termsRead(words: string[]): string {
	return words.map((term) => term.split('|')[0]?.trim() ?? term).join(', ');
}

const KIND_WORDS: [string, FileKind][] = [
	['doc', 'Document'],
	['docs', 'Document'],
	['document', 'Document'],
	['sheet', 'Spreadsheet'],
	['sheets', 'Spreadsheet'],
	['spreadsheet', 'Spreadsheet'],
	['deck', 'Presentation'],
	['slides', 'Presentation'],
	['presentation', 'Presentation'],
	['folder', 'Folder'],
];

export type FileSearch = {
	words: string[];
	kind: FileKind | null;
	ownerName: string | null;
};

/**
 * What to look for among the files: the words of the name the model found, or of everything typed
 * when it found none ("the q3 board deck"), without the kind ("deck", "spreadsheet"), which becomes
 * the kind to look for, the owner's name or filler such as "find" and "the".
 */
export function fileSearch(intent: Intent, typed: string): FileSearch {
	const [name] = fieldTexts(intent, 'name');
	const [ownerName = null] = fieldTexts(intent, 'owner');
	const ownerWords = new Set(ownerName ? words(ownerName) : []);
	const all = words(name ?? typed);
	const kinds = all.flatMap((word) =>
		KIND_WORDS.filter(([kindWord]) => kindWord === word).map(([, kind]) => kind),
	);
	return {
		words: all.filter(
			(word) =>
				!FILLER.has(word) &&
				!ownerWords.has(word) &&
				!KIND_WORDS.some(([kindWord]) => kindWord === word),
		),
		kind: kinds[0] ?? null,
		ownerName,
	};
}

// What a meeting, an email or an issue is called around its name, left out of the search as the
// kind of file is.
const KIND_NOUNS = new Set(
	'meeting meetings call calls email emails mail issue issues ticket tickets page pages'.split(' '),
);

const ASK_IN = ['meetings', 'documents', 'emails', 'issues'] as const;

export type AskIn = (typeof ASK_IN)[number];

export type AskSearch = {
	/** Where to look: the meetings, the documents (in Drive and Notion), the emails or the issues. */
	in: AskIn;
	/** Who the meeting was with, who sent the email, or who owns the file. */
	people: string[];
	/** Words of the meeting's or file's name or topic. */
	words: string[];
	/** The kind of file said ("the pricing deck"), to prefer. */
	kind: FileKind | null;
	days: Days | null;
};

/**
 * What Ask looks for: where the model said, else the meetings when people are named, since a
 * document is seldom asked about by who owns it, and the documents when none are; by the people, the words
 * of the name or topic without filler, the kind of file said anywhere in what was typed, and the
 * days said.
 */
export function askSearch(intent: Intent, typed: string, now: Date): AskSearch {
	const [said] = fieldTexts(intent, 'askIn');
	const people = namesIn(intent, 'askWith');
	const [about = ''] = fieldTexts(intent, 'askAbout');
	const kinds = words(typed).flatMap((word) =>
		KIND_WORDS.filter(([kindWord]) => kindWord === word).map(([, kind]) => kind),
	);
	return {
		in: ASK_IN.find((one) => one === said) ?? (people.length > 0 ? 'meetings' : 'documents'),
		people,
		words: words(about).filter(
			(word) =>
				!FILLER.has(word) &&
				!KIND_NOUNS.has(word) &&
				!KIND_WORDS.some(([kindWord]) => kindWord === word),
		),
		kind: kinds[0] ?? null,
		days: meetingDays(typed, now),
	};
}

/** The first address of an email's sender as a list shows it: "Sam Lee <sam@…>" is Sam Lee. */
export function senderName(from: string): string {
	const named = /^\s*"?([^"<]+?)"?\s*<[^>]+>/.exec(from);
	return named?.[1]?.trim() ?? from.split(',')[0]?.trim() ?? from;
}
