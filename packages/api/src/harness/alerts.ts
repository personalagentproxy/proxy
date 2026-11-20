import {Err, Ok, type Result} from 'ts-results-es';
import {z} from 'zod';

import {cut} from '@proxy/utils/harness';
import type {AlertRow, MemberAlertRow, NewAlert} from '@proxy/db/alerts';
import {integrationFor} from '@proxy/integrations';

import type {Change} from '../records/connector';
import {checkEvery, DEFAULT_TIME_ZONE, everyText} from './alert-repeat';

/**
 * The built-in agent's alerts: a wake-up from outside a thread, set by the thread's agent when the
 * person asks to be told at a time, or when something happens in their accounts. The agent says
 * where each comes: to the thread it is set in, as a follow-up of its work, or to the chat, where
 * each time it opens a new thread, for a standing rule, its brief all that thread's agent knows of
 * why; one of those may repeat (alert-repeat.ts), and, a watch, opens a thread for each look that
 * found something or for each record. A timed alert lands what the agent noted when it is due. A
 * watch is a rule on a collection of some connections, polled every so often (alert-sweep.ts): a
 * record new or changed there that carries any of the watch's words, matched as written, lands with
 * its link. A thread an alert opened may be dismissed by its agent, archived without telling the
 * person, where what came is nothing for them. Here: what set_alert takes, how a record is matched,
 * and the words of it all, for the agent; which connections may be watched is watch-connections.ts.
 */

export const SET_ALERT_TOOL = 'set_alert';
export const CANCEL_ALERT_TOOL = 'cancel_alert';
export const DISMISS_TOOL = 'dismiss';

/** How often a connection's collection is polled while a watch is on it, and a timed alert whose turn failed comes again. */
export const POLL_EVERY_MS = 10 * 60 * 1000;

/** The collections a watch can be on, by the catalog's id, each as the agent is told of it. */
export const WATCHED_COLLECTIONS = {emails: 'emails', issues: 'issues', events: 'calendar events'} as const;

export type WatchedCollection = keyof typeof WATCHED_COLLECTIONS;

function isWatchedCollection(collectionId: string): collectionId is WatchedCollection {
	return collectionId in WATCHED_COLLECTIONS;
}

const MAX_TITLE = 120;
const MAX_AHEAD_MS = 366 * 24 * 60 * 60 * 1000;
// A time the model meant as now, given a moment ago, is taken as now rather than refused.
const PAST_SLACK_MS = 60 * 1000;

const argsSchema = z.object({
	title: z.string().trim().min(1).max(MAX_TITLE),
	brief: z.string().trim().min(1),
	opens: z.enum(['this_thread', 'new_thread']),
	at: z.iso.datetime({offset: true}).optional(),
	every: z.string().trim().min(1).max(500).optional(),
	collection: z.enum(['emails', 'issues', 'events']).optional(),
	connections: z.array(z.string().min(1)).min(1).max(50).optional(),
	terms: z.array(z.string().trim().min(1).max(200)).max(50).optional(),
	split: z.enum(['per_check', 'per_record']).optional(),
});

/** What set_alert takes, as it is told to the model (tool-surface.ts). */
export const SET_ALERT_PARAMETERS = {
	type: 'object',
	properties: {
		title: {type: 'string', description: 'A few words'},
		brief: {
			type: 'string',
			description: 'What to tell the person or do when it comes. For new_thread, all that thread’s agent will know: write it in full',
		},
		opens: {
			type: 'string',
			enum: ['this_thread', 'new_thread'],
			description: 'this_thread: wakes this thread, for a follow-up of its work. new_thread: opens a new thread each time, for a standing rule or work of its own',
		},
		at: {type: 'string', description: 'ISO 8601 with offset, for a timed alert; its first time where it repeats'},
		every: {
			type: 'string',
			description: 'new_thread only: an RRULE to repeat by after at, in the person’s time zone, such as FREQ=WEEKLY;BYDAY=MO;BYHOUR=9;BYMINUTE=0',
		},
		collection: {type: 'string', enum: Object.keys(WATCHED_COLLECTIONS), description: 'For a watch'},
		connections: {type: 'array', items: {type: 'string'}, description: 'Ids to watch; left out, all you may read'},
		terms: {
			type: 'array',
			items: {type: 'string'},
			description: 'Any one must appear; left out, everything new matches',
		},
		split: {
			type: 'string',
			enum: ['per_check', 'per_record'],
			description: 'A new_thread watch’s: a thread for everything one check found, or one for each record',
		},
	},
	required: ['title', 'brief', 'opens'],
	additionalProperties: false,
};

// A watch as set_alert asks for it: its connections those named, or null for every one the agent may watch.
type WatchSpec<W> = Omit<W, 'collectionId' | 'connectionIds'> & {collectionId: WatchedCollection; connectionIds: string[] | null};

/** An alert as set_alert asks for it. */
export type AlertSpec = Extract<NewAlert, {kind: 'time'}> | WatchSpec<Extract<NewAlert, {kind: 'watch'; opens: 'this_thread'}>> | WatchSpec<Extract<NewAlert, {kind: 'watch'; opens: 'new_thread'}>>;

type Args = z.infer<typeof argsSchema>;

// A watch as set_alert asks for it, split as asked where it opens new threads.
function watchArgs(args: Args, collection: WatchedCollection): Result<AlertSpec, string> {
	if (args.every !== undefined) {
		return Err('every is for a timed alert: a watch comes for each new record anyway.');
	}
	const watch = {
		kind: 'watch' as const,
		title: args.title,
		brief: args.brief,
		collectionId: collection,
		connectionIds: args.connections === undefined ? null : [...new Set(args.connections)],
		terms: [...new Set((args.terms ?? []).map((term) => term.toLowerCase()))],
	};
	if (args.opens === 'this_thread') {
		if (args.split !== undefined) {
			return Err('split is for a new_thread watch: this_thread lands everything in this thread.');
		}
		return Ok({...watch, opens: 'this_thread'});
	}
	if (args.split === undefined) {
		return Err('Give split for a new_thread watch: per_check, a thread for everything one check found, or per_record, one for each record.');
	}
	return Ok({...watch, opens: 'new_thread', split: args.split});
}

/**
 * A set_alert call's arguments, checked: a title, a brief and where it opens, with either `at`, a
 * time ahead within a year, repeating by `every` in `timeZone` where it opens new threads, or
 * `collection`, with the connections, the terms, and, opening new threads, how it splits. `Err`
 * says what is wrong, for the model.
 */
export function alertArgs(args: unknown, now: Date, timeZone: string): Result<AlertSpec, string> {
	const parsed = argsSchema.safeParse(args);
	if (!parsed.success) {
		return Err(`The arguments are no good: ${z.prettifyError(parsed.error)}`);
	}
	const {title, brief, opens, at, every, collection} = parsed.data;
	if ((at === undefined) === (collection === undefined)) {
		return Err('Give at, for a message at that time, or collection, for a watch: one of the two.');
	}
	if (collection !== undefined) {
		return watchArgs(parsed.data, collection);
	}
	if (parsed.data.split !== undefined) {
		return Err('split is for a watch.');
	}
	const time = new Date(at ?? '').getTime();
	if (time < now.getTime() - PAST_SLACK_MS) {
		return Err(`at is in the past: the time now is ${now.toISOString()}.`);
	}
	if (time > now.getTime() + MAX_AHEAD_MS) {
		return Err('at is more than a year ahead.');
	}
	const first = new Date(Math.max(time, now.getTime()));
	if (opens === 'this_thread') {
		if (every !== undefined) {
			return Err('every is for new_thread: a repeating alert opens a new thread each time, so this one doesn’t grow without end.');
		}
		return Ok({kind: 'time', title, brief, opens, at: first});
	}
	if (every === undefined) {
		return Ok({kind: 'time', title, brief, opens, at: first, every: null});
	}
	const rule = checkEvery(every, first, timeZone);
	if (rule.isErr()) {
		return rule;
	}
	return Ok({kind: 'time', title, brief, opens, at: first, every: {rule: rule.value, timeZone}});
}

/** What the person calls the connection, or its integration and account. */
export function connectionName(connection: {name: string | null; integrationId: string; account: string}): string {
	return connection.name ?? `${integrationFor(connection)?.name ?? connection.integrationId} (${connection.account})`;
}

/** Whether a record carries any of the watch's words, in its title or its summary; every record does where there are none. */
export function matches(terms: string[], change: Change): boolean {
	if (terms.length === 0) {
		return true;
	}
	const text = `${change.title}\n${change.summary}`.toLowerCase();
	return terms.some((term) => text.includes(term.toLowerCase()));
}

// "“loan”, “mortgage” or “rate”"; "anything new" for none.
function listed(terms: string[]): string {
	if (terms.length === 0) {
		return 'anything new';
	}
	const quoted = terms.map((term) => `“${term}”`);
	if (quoted.length === 1) {
		return quoted.join('');
	}
	return `${quoted.slice(0, -1).join(', ')} or ${quoted.at(-1) ?? ''}`;
}

/** What a watch watches, in words ("emails"); null for a timed alert. */
export function collectionName(collectionId: string | null): string | null {
	if (collectionId === null) {
		return null;
	}
	return isWatchedCollection(collectionId) ? WATCHED_COLLECTIONS[collectionId] : collectionId;
}

/** When an alert comes, in words: a timed one's next time, and how it repeats, or what a watch watches, where and for what. */
export function alertComes(alert: AlertRow): string {
	if (alert.collectionId === null) {
		const due = `due ${(alert.nextAt ?? alert.at)?.toISOString() ?? ''}`;
		return alert.every === null ? due : `${due}, then ${everyText(alert.every, alert.timeZone ?? DEFAULT_TIME_ZONE)}`;
	}
	return `watching ${collectionName(alert.collectionId) ?? ''} in connection${alert.connectionIds.length === 1 ? '' : 's'} ${alert.connectionIds.join(', ')} for ${listed(alert.terms)}`;
}

/** An alert in a line, as the agent is told of it: its id, its title and what it is. */
export function describeAlert(alert: AlertRow): string {
	return `${alert.id}: “${alert.title}”, ${alertComes(alert)}`;
}

// A thread, as the agent of the thread `threadId` is told of it: this one, or another by its title.
function threadName(thread: {id: string; title: string} | null, threadId: string): string {
	if (thread === null) {
		return 'a thread since gone';
	}
	if (thread.id === threadId) {
		return 'this thread';
	}
	return thread.title === '' ? 'another thread' : `the thread “${thread.title}”`;
}

// Where an alert comes, as the agent of the thread `threadId` is told: to a thread, this one or
// another, or to the chat, a new thread each time, set in this thread or another.
function comesTo(alert: MemberAlertRow, threadId: string): string {
	if (alert.threadId !== null) {
		return `comes to ${threadName(alert.thread, threadId)}`;
	}
	const split = alert.split === 'per_record' ? ' (one for each record)' : '';
	return `opens a new thread each time${split}; set in ${threadName(alert.setIn, threadId)}`;
}

/**
 * What a thread's agent is told, in its instructions, of the person's alerts: every one of theirs,
 * whichever thread it was set in and comes to, since what they ask about an alert they ask in a
 * new thread, which set none.
 */
export function alertsParagraph(alerts: MemberAlertRow[], threadId: string): string {
	if (alerts.length === 0) {
		return 'No alerts.';
	}
	const lines = alerts.map((alert) => `- ${describeAlert(alert)}; ${comesTo(alert, threadId)}`);
	return `The person’s alerts:\n${lines.join('\n')}`;
}

/** What an alert that opens new threads says of the thread it was set in, for its agent to read up on where it can; nothing for one that comes to its thread. */
export function setInText(alert: AlertRow, setInTitle: string | null): string {
	if (alert.threadId !== null || alert.setInThreadId === null) {
		return '';
	}
	return ` You set it in the thread ${setInTitle ? `“${setInTitle}” ` : ''}(id ${alert.setInThreadId}).`;
}

/** What a timed alert lands when it is due. */
export function dueText(alert: AlertRow, setInTitle: string | null): string {
	const when = alert.every === null ? `for ${alert.at?.toISOString() ?? ''}` : `to come ${everyText(alert.every, alert.timeZone ?? DEFAULT_TIME_ZONE)}`;
	return `The alert “${alert.title}” is due now, which you set ${when}.${setInText(alert, setInTitle)} What you noted for it: ${alert.brief}`;
}

// How much of a record's summary a match carries.
const MAX_SUMMARY = 300;

// How dueText and matchText open, for the line the thread shows of what they landed: the alert's
// title, and how many records of which collection matched.
const DUE_OPENING = /^The alert “(.+?)” is due now, which you set /;
const MATCH_OPENING = /^The alert “(.+?)” matched (?:a new one of the (.+?)|(\d+) new (.+?)) it watches, /;

/**
 * What an event says in a line, as the person sees it in its thread, where the whole of it is
 * for the agent: an alert that landed by its title and what came, “Mail from the bank” matched a
 * new email; anything else by its first line.
 */
export function eventLine(text: string): string {
	const due = DUE_OPENING.exec(text);
	if (due) {
		return `“${due[1]}” is due`;
	}
	const match = MATCH_OPENING.exec(text);
	if (!match) {
		return text.split('\n', 1)[0] ?? '';
	}
	const [, title, one, count, many] = match;
	if (one !== undefined) {
		return `“${title}” matched a new ${one.replace(/s$/, '')}`;
	}
	return `“${title}” matched ${count} new ${many}`;
}

/** What a watch is told of the records that matched it now, with their links, for the agent to pass on. */
export function matchText(alert: AlertRow, changes: Change[], setInTitle: string | null): string {
	const name = collectionName(alert.collectionId) ?? '';
	const lines = changes.map((change) => `- ${change.title}${change.url ? ` (${change.url})` : ''} — ${cut(change.summary, MAX_SUMMARY)}; id ${change.id}`);
	return [
		`The alert “${alert.title}” matched ${changes.length === 1 ? `a new one of the ${name}` : `${changes.length} new ${name}`} it watches, for ${listed(alert.terms)}:`,
		lines.join('\n'),
		`What you noted for it: ${alert.brief}${setInText(alert, setInTitle)}`,
	].join('\n\n');
}
