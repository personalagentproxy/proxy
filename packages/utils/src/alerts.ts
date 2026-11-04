import {Err, Ok, type Result} from 'ts-results-es';

import {cut} from './harness';

/**
 * The built-in agent's alerts, as the api sets and runs them and the web app shows them. An alert
 * is a wake-up outside the conversation: a timed one, when what the agent noted for it is handed
 * to the agent to tell the person; or a watch, a rule on a collection of some connections, which
 * fires when a record new or changed there says what the rule's criteria ask. The criteria are
 * words, matched mechanically: the agent writes them when the person asks, from what they said.
 * The connections are polled every so often for what is new while any watch is on them
 * (`POLL_EVERY_MS`), once each however many watch them.
 */

/** The main agent's tools for them: one sets an alert, the other ends one. */
export const SET_ALERT_TOOL = 'set_alert';
export const CANCEL_ALERT_TOOL = 'cancel_alert';

// How long a title may be: a task's.
const MAX_TITLE = 120;

const MINUTE_MS = 60 * 1000;
const DAY_MS = 24 * 60 * MINUTE_MS;

/** How far ahead a timed alert may be set. */
export const MAX_AT_MS = 366 * DAY_MS;

// A time the model meant as now, given a moment ago, is taken as now rather than refused.
const PAST_SLACK_MS = MINUTE_MS;

/** How often a connection's collection is polled while a watch is on it. */
export const POLL_EVERY_MS = 10 * MINUTE_MS;

/** How many new records one poll takes at most: the newest, the rest left for the next. */
export const MAX_POLL_ITEMS = 50;

/**
 * The collections a watch can be on, by the catalog's collection id, each with the fields of a
 * record the criteria can name, beside `any`, which is every field the record carries.
 */
export const WATCH_COLLECTIONS = {
	emails: {name: 'emails', fields: ['from', 'to', 'subject', 'snippet']},
	issues: {name: 'issues', fields: ['title', 'team', 'status', 'assignee']},
	events: {name: 'calendar events', fields: ['title', 'organizer', 'guests', 'status']},
} as const;

export type WatchCollection = keyof typeof WATCH_COLLECTIONS;

export const ANY_FIELD = 'any';

export function isWatchCollection(id: string): id is WatchCollection {
	return Object.hasOwn(WATCH_COLLECTIONS, id);
}

/** One condition of a watch: the field holds any of the terms, case-insensitive. */
export type Condition = {field: string; terms: string[]};

/** A watch's criteria: every condition holds; none, and every new record matches. */
export type Criteria = Condition[];

/** A record new or changed in a polled collection, as a connector reports it: its fields are what the criteria read. */
export type PollItem = {
	recordId: string;
	title: string;
	url: string | null;
	// When it happened, in ISO 8601.
	at: string;
	fields: Record<string, string>;
};

/** An alert as set_alert sets it: at a time, or a watch on a collection of some connections. */
export type AlertSpec = {title: string; brief: string} & (
	| {kind: 'time'; at: Date}
	| {
			kind: 'watch';
			collectionId: WatchCollection;
			connectionIds: string[] | null;
			criteria: Criteria;
	  }
);

// How many conditions, terms and how long a term a watch may have.
const MAX_CONDITIONS = 10;
const MAX_TERMS = 20;
const MAX_TERM = 200;

function parseTime(value: unknown): Date | null | undefined {
	if (value === undefined || value === null) {
		return null;
	}
	if (typeof value !== 'string') {
		return undefined;
	}
	const parsed = new Date(value);
	return Number.isNaN(parsed.getTime()) ? undefined : parsed;
}

function fieldsOf(collectionId: WatchCollection): string[] {
	return [...WATCH_COLLECTIONS[collectionId].fields, ANY_FIELD];
}

// The criteria as `match` gives them: a list of {field, terms}, each field one of the collection's.
function parseConditions(value: unknown, collectionId: WatchCollection): Result<Criteria, string> {
	if (value === undefined || value === null) {
		return Ok([]);
	}
	if (!Array.isArray(value)) {
		return Err('Give match as a list of {field, terms}.');
	}
	if (value.length > MAX_CONDITIONS) {
		return Err(`Give at most ${MAX_CONDITIONS} conditions.`);
	}
	const fields = fieldsOf(collectionId);
	const criteria: Criteria = [];
	for (const condition of value) {
		if (typeof condition !== 'object' || condition === null) {
			return Err('Give each condition as {field, terms}.');
		}
		const {field, terms} = condition as {field?: unknown; terms?: unknown};
		if (typeof field !== 'string' || !fields.includes(field)) {
			return Err(
				`A condition's field is one of ${fields.join(', ')} for ${WATCH_COLLECTIONS[collectionId].name}.`,
			);
		}
		if (
			!Array.isArray(terms) ||
			terms.length === 0 ||
			!terms.every((term) => typeof term === 'string' && term.trim() !== '')
		) {
			return Err('A condition’s terms are a list of words or phrases, at least one.');
		}
		if (terms.length > MAX_TERMS) {
			return Err(`Give at most ${MAX_TERMS} terms in a condition.`);
		}
		criteria.push({field, terms: terms.map((term: string) => cut(term.trim(), MAX_TERM))});
	}
	return Ok(criteria);
}

function parseConnections(value: unknown): Result<string[] | null, string> {
	if (value === undefined || value === null) {
		return Ok(null);
	}
	if (!Array.isArray(value) || !value.every((id) => typeof id === 'string' && id !== '')) {
		return Err(
			'Give connections as a list of connection ids, or leave it out for every connection with the collection.',
		);
	}
	return Ok([...new Set(value as string[])]);
}

/**
 * What set_alert was given, checked: a title and a brief; either `at`, a time ahead, within a year,
 * for a timed alert, or `collection`, one of the watchable ones, with `connections` and `match`,
 * for a watch. `Err` says what is wrong, for the model.
 */
export function alertArgs(args: unknown, now: Date): Result<AlertSpec, string> {
	if (typeof args !== 'object' || args === null) {
		return Err('Give title, brief, and at or collection.');
	}
	const {title, brief, at, collection, connections, match} = args as Record<string, unknown>;
	if (typeof title !== 'string' || title.trim() === '') {
		return Err('Give title, what the alert is in a few words.');
	}
	if (typeof brief !== 'string' || brief.trim() === '') {
		return Err('Give brief: what to tell the person at the time, or what the watch is for.');
	}
	const spec = {title: cut(title.trim(), MAX_TITLE), brief: brief.trim()};
	const time = parseTime(at);
	if (time === undefined) {
		return Err('Give at as a time in ISO 8601 with its offset, such as 2026-10-22T07:30:00-07:00.');
	}
	if (time !== null && collection !== undefined && collection !== null) {
		return Err('Give at, for one message at that time, or collection, for a watch, not both.');
	}
	if (time !== null) {
		if (time.getTime() < now.getTime() - PAST_SLACK_MS) {
			return Err(`at is in the past: the time now is ${now.toISOString()}.`);
		}
		if (time.getTime() > now.getTime() + MAX_AT_MS) {
			return Err('at is more than a year ahead.');
		}
		return Ok({...spec, kind: 'time', at: new Date(Math.max(time.getTime(), now.getTime()))});
	}
	if (typeof collection !== 'string' || !isWatchCollection(collection)) {
		return Err(
			`Give at, a time in ISO 8601, for one message at that time; or collection, one of ${Object.keys(WATCH_COLLECTIONS).join(', ')}, for a watch.`,
		);
	}
	const connectionIds = parseConnections(connections);
	if (connectionIds.isErr()) {
		return connectionIds;
	}
	const criteria = parseConditions(match, collection);
	if (criteria.isErr()) {
		return criteria;
	}
	return Ok({
		...spec,
		kind: 'watch',
		collectionId: collection,
		connectionIds: connectionIds.value,
		criteria: criteria.value,
	});
}

/** The criteria from the JSON they are kept as; none where there is none, or it isn't that. */
export function parseCriteria(json: string | null): Criteria {
	if (json === null) {
		return [];
	}
	const parsed = ((): unknown => {
		try {
			return JSON.parse(json);
		} catch {
			return null;
		}
	})();
	if (!Array.isArray(parsed)) {
		return [];
	}
	return parsed.flatMap((condition: unknown) => {
		if (typeof condition !== 'object' || condition === null) {
			return [];
		}
		const {field, terms} = condition as {field?: unknown; terms?: unknown};
		if (typeof field !== 'string' || !Array.isArray(terms)) {
			return [];
		}
		return [{field, terms: terms.filter((term): term is string => typeof term === 'string')}];
	});
}

function holds(condition: Condition, item: PollItem): boolean {
	const text = (
		condition.field === ANY_FIELD
			? Object.values(item.fields)
			: [item.fields[condition.field] ?? '']
	)
		.join('\n')
		.toLowerCase();
	return condition.terms.some((term) => text.includes(term.toLowerCase()));
}

/** Whether a record says what the criteria ask: every condition holds; none, and it does. */
export function matches(criteria: Criteria, item: PollItem): boolean {
	return criteria.every((condition) => holds(condition, item));
}

// "loan", "loan or mortgage", "loan, mortgage or rate".
function listed(terms: string[]): string {
	const quoted = terms.map((term) => `“${term}”`);
	if (quoted.length <= 1) {
		return quoted.join('');
	}
	return `${quoted.slice(0, -1).join(', ')} or ${quoted.at(-1) ?? ''}`;
}

/** The criteria in words: "from contains “@bank.com”, and subject contains “loan” or “mortgage”"; "anything new" for none. */
export function describeCriteria(criteria: Criteria): string {
	if (criteria.length === 0) {
		return 'anything new';
	}
	return criteria
		.map(
			(condition) =>
				`${condition.field === ANY_FIELD ? 'any field' : condition.field} contains ${listed(condition.terms)}`,
		)
		.join(', and ');
}
