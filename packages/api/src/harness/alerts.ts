import {Err, Ok, type Result} from 'ts-results-es';
import {z} from 'zod';

import {cut} from '@proxy/utils/harness';
import type {AlertRow, NewAlert} from '@proxy/db/alerts';
import {integrationFor} from '@proxy/integrations';

import type {Change} from '../records/connector';

/**
 * The built-in agent's alerts: a wake-up outside the conversation, set by the agent talking with
 * the person when they ask to be told at a time, or when something happens in their accounts. A
 * timed alert lands what the agent noted in the conversation when it is due. A watch is a rule on
 * a collection of some connections, polled every so often (watches.ts): a record new or changed
 * there that carries any of the watch's words, matched as written, lands in the conversation with
 * its link. Here: what set_alert takes, how a record is matched, and the words of it all, for the
 * agent; which connections may be watched is watch-connections.ts.
 */

export const SET_ALERT_TOOL = 'set_alert';
export const CANCEL_ALERT_TOOL = 'cancel_alert';

/** How often a connection's collection is polled while a watch is on it. */
export const POLL_EVERY_MS = 10 * 60 * 1000;

/** The collections a watch can be on, by the catalog's id, each as the agent is told of it. */
export const WATCHED_COLLECTIONS = {emails: 'emails', issues: 'issues', events: 'calendar events'} as const;

export type WatchedCollection = keyof typeof WATCHED_COLLECTIONS;

const MAX_TITLE = 120;
const MAX_AHEAD_MS = 366 * 24 * 60 * 60 * 1000;
// A time the model meant as now, given a moment ago, is taken as now rather than refused.
const PAST_SLACK_MS = 60 * 1000;

const argsSchema = z.object({
	title: z.string().trim().min(1).max(MAX_TITLE),
	brief: z.string().trim().min(1),
	at: z.iso.datetime({offset: true}).optional(),
	collection: z.enum(['emails', 'issues', 'events']).optional(),
	connections: z.array(z.string().min(1)).max(50).optional(),
	terms: z.array(z.string().trim().min(1).max(200)).max(50).optional(),
});

/** What set_alert takes, as it is told to the model (tool-surface.ts). */
export const SET_ALERT_PARAMETERS = {
	type: 'object',
	properties: {
		title: {type: 'string', description: 'What the alert is, in a few words, such as "Reply from the landlord"'},
		brief: {type: 'string', description: 'What you noted for it: for a time, what to tell the person then or what to do; for a watch, what it is for, which you are reminded of with each match'},
		at: {type: 'string', description: 'When to be woken once, in ISO 8601 with its offset, such as 2026-10-22T07:30:00-07:00; for a timed alert'},
		collection: {type: 'string', enum: Object.keys(WATCHED_COLLECTIONS), description: 'What to watch; for a watch'},
		connections: {type: 'array', items: {type: 'string'}, description: 'The connections to watch, by id; left out for every one you may read with the collection'},
		terms: {
			type: 'array',
			items: {type: 'string'},
			description: 'Words or phrases, any one of which a new record has to contain, matched as written, not understood; left out, everything new matches',
		},
	},
	required: ['title', 'brief'],
	additionalProperties: false,
};

/** An alert as set_alert asks for it: a watch's connections are those named, or null for every one the agent may watch. */
export type AlertSpec =
	Extract<NewAlert, {kind: 'time'}> | (Omit<Extract<NewAlert, {kind: 'watch'}>, 'collectionId' | 'connectionIds'> & {collectionId: WatchedCollection; connectionIds: string[] | null});

/**
 * A set_alert call's arguments, checked: a title and a brief, with either `at`, a time ahead within
 * a year, or `collection`, with the connections and the terms. `Err` says what is wrong, for the
 * model.
 */
export function alertArgs(args: unknown, now: Date): Result<AlertSpec, string> {
	const parsed = argsSchema.safeParse(args);
	if (!parsed.success) {
		return Err(`The arguments are no good: ${z.prettifyError(parsed.error)}`);
	}
	const {title, brief, at, collection, connections, terms} = parsed.data;
	if ((at === undefined) === (collection === undefined)) {
		return Err('Give at, for one message at that time, or collection, for a watch: one of the two.');
	}
	if (collection !== undefined) {
		return Ok({
			kind: 'watch',
			title,
			brief,
			collectionId: collection,
			connectionIds: connections === undefined ? null : [...new Set(connections)],
			terms: [...new Set((terms ?? []).map((term) => term.toLowerCase()))],
		});
	}
	const time = new Date(at ?? '').getTime();
	if (time < now.getTime() - PAST_SLACK_MS) {
		return Err(`at is in the past: the time now is ${now.toISOString()}.`);
	}
	if (time > now.getTime() + MAX_AHEAD_MS) {
		return Err('at is more than a year ahead.');
	}
	return Ok({kind: 'time', title, brief, at: new Date(Math.max(time, now.getTime()))});
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

function collectionName(collectionId: string | null): string {
	return collectionId !== null && collectionId in WATCHED_COLLECTIONS ? WATCHED_COLLECTIONS[collectionId as WatchedCollection] : (collectionId ?? '');
}

/** An alert in a line, as the agent is told of it: its id, its title and what it is. */
export function describeAlert(alert: AlertRow): string {
	if (alert.collectionId === null) {
		return `${alert.id}: “${alert.title}”, due ${alert.at?.toISOString() ?? ''}`;
	}
	return `${alert.id}: “${alert.title}”, watching ${collectionName(alert.collectionId)} in connection${alert.connectionIds.length === 1 ? '' : 's'} ${alert.connectionIds.join(', ')} for ${listed(alert.terms)}`;
}

/** What the agent is told, in its instructions, of the alerts set in its conversation. */
export function alertsParagraph(alerts: AlertRow[]): string {
	if (alerts.length === 0) {
		return 'No alert is set in this conversation.';
	}
	return `The alerts set in this conversation, each by the id cancel_alert takes:\n${alerts.map((alert) => `- ${describeAlert(alert)}`).join('\n')}`;
}

/** What a timed alert lands in the conversation when it is due. */
export function dueText(alert: {title: string; brief: string; at: Date | null}): string {
	return `The alert “${alert.title}” is due now, which you set for ${alert.at?.toISOString() ?? ''}. What you noted for it: ${alert.brief}`;
}

// How much of a record's summary a match carries.
const MAX_SUMMARY = 300;

/** What a watch's conversation is told of the records that matched it now, with their links, for the agent to pass on. */
export function matchText(alert: AlertRow, changes: Change[]): string {
	const name = collectionName(alert.collectionId);
	const lines = changes.map((change) => `- ${change.title}${change.url ? ` (${change.url})` : ''} — ${cut(change.summary, MAX_SUMMARY)}; id ${change.id}`);
	return [
		`The alert “${alert.title}” matched ${changes.length === 1 ? `a new one of the ${name}` : `${changes.length} new ${name}`} it watches, for ${listed(alert.terms)}:`,
		lines.join('\n'),
		`What you noted for it: ${alert.brief}`,
	].join('\n\n');
}
