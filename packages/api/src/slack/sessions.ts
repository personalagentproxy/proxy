import type {Result} from 'ts-results-es';

import type {ApiError} from '@proxy/utils';
import {markSlackAppRemoved} from '@proxy/db/slack';
import {
	getSlackSessionPlace,
	noteSlackSessionFailed,
	noteSlackSessionRenamed,
	noteSlackSessionSet,
	readSlackSessionState,
	type SlackSessionPlace,
	turnSlackSessionsOff,
} from '@proxy/db/slack-sessions';

import {standingOf} from '../harness/thread-standing';
import {log, serializeError} from '../observability/log';
import {renameDue, sessionDue, sessionFailure, sessionRetryMs, sessionsOn, SESSIONS_OFF_MS, sessionStatusOf} from './session-rules';
import {readBotToken} from './secrets';
import {renameSession, type SessionStatus, setSessionStatus, type SlackError} from './slack-api';

/**
 * Where a thread that lives in Slack stands, shown there with Slack's own agent session status on
 * its Slack thread, as session-rules.ts says: set `processing` as a message from Slack is taken up
 * (`promptSession`), and kept true after by the delivery sweep (`keepSession`, delivery.ts), once
 * what the thread said is posted. The session is made by the first status set, with the thread's
 * title then, which is a line of the member's first message; once a small model has named the
 * thread (harness/thread-title.ts), which it does as the first turn starts, the session is renamed
 * to that, once, and a title the member gives it in Slack after stays. All of it is best-effort:
 * nothing about messages waits on it. Where Slack says its agent features aren't there for the app,
 * no session call is made for it for a day; any other failure is logged once and tried again a
 * while later.
 */

/** What setting a session's status and title needs of the database. */
export type SessionStore = {
	place: typeof getSlackSessionPlace;
	state: typeof readSlackSessionState;
	noteSet: typeof noteSlackSessionSet;
	noteRenamed: typeof noteSlackSessionRenamed;
	noteFailed: typeof noteSlackSessionFailed;
	turnOff: typeof turnSlackSessionsOff;
	markAppRemoved: typeof markSlackAppRemoved;
};

export const sessionStore: SessionStore = {
	place: getSlackSessionPlace,
	state: readSlackSessionState,
	noteSet: noteSlackSessionSet,
	noteRenamed: noteSlackSessionRenamed,
	noteFailed: noteSlackSessionFailed,
	turnOff: turnSlackSessionsOff,
	markAppRemoved: markSlackAppRemoved,
};

// Logs a write of ours that failed; the session is set again when it is next due.
function logged(what: string, place: SlackSessionPlace, result: Result<void, ApiError>): void {
	if (result.isErr()) {
		log.warn(what, {placeId: place.id, ...serializeError(result.error)});
	}
}

// Notes what Slack's no to a session call comes to, as session-rules.ts reads it: the app's
// sessions off for a day, the app marked removed, or the place tried again later. A session that
// isn't there to rename is left with the title it has, `title` noted as given, so it isn't asked again.
async function afterFailure(store: SessionStore, place: SlackSessionPlace, error: SlackError, now: Date, title: string | null): Promise<void> {
	const failure = sessionFailure(error);
	if (failure.kind === 'unavailable') {
		log.info('Slack’s agent sessions aren’t there for a persona’s app; none is set for a day', {appId: place.app.id, why: failure.why});
		logged('A Slack app’s sessions could not be turned off', place, await store.turnOff(place.app.id, new Date(now.getTime() + SESSIONS_OFF_MS)));
		return;
	}
	if (failure.kind === 'app_gone') {
		log.info('Slack no longer takes a persona’s app’s token; it is marked removed', {appId: place.app.id});
		logged('A Slack app Slack no longer takes could not be marked removed', place, await store.markAppRemoved(place.app.id));
		return;
	}
	if (failure.kind === 'no_session' && title !== null) {
		logged('A Slack session’s title could not be noted', place, await store.noteRenamed(place.id, title));
		return;
	}
	if (failure.kind === 'rate_limited') {
		logged('A Slack session’s failure could not be noted', place, await store.noteFailed(place.id, place.session.attempts, new Date(now.getTime() + failure.waitMs)));
		return;
	}
	// Logged as it starts failing, not at every try after.
	if (place.session.attempts === 0) {
		log.warn('A Slack session could not be set; it is tried again later', {placeId: place.id, method: error.method, kind: error.kind, ...(error.kind === 'refused' ? {error: error.error} : {})});
	}
	const attempts = place.session.attempts + 1;
	logged('A Slack session’s failure could not be noted', place, await store.noteFailed(place.id, attempts, new Date(now.getTime() + sessionRetryMs(attempts))));
}

/**
 * Sets the place's session to `status`, made with `title` where no status was set before, and
 * notes what came of it. Whether it was set.
 */
export async function setSession(store: SessionStore, token: string, place: SlackSessionPlace, status: SessionStatus, title: string | null, now: Date): Promise<boolean> {
	const making = place.session.status === null;
	const set = await setSessionStatus(token, {channel: place.channel, threadTs: place.rootTs, status, title: making ? title : null});
	if (set.isErr()) {
		await afterFailure(store, place, set.error, now, null);
		return false;
	}
	logged('A Slack session’s status could not be noted', place, await store.noteSet(place.id, status, now, making ? {title} : null));
	return true;
}

// Renames the place's session to the thread's title, and notes what came of it.
async function renameTo(store: SessionStore, token: string, place: SlackSessionPlace, title: string, now: Date): Promise<void> {
	// Slack takes no title of nothing: one the thread can't have is noted as given, and left.
	if (title.trim() === '') {
		logged('A Slack session’s title could not be noted', place, await store.noteRenamed(place.id, title));
		return;
	}
	const renamed = await renameSession(token, {channel: place.channel, threadTs: place.rootTs, title});
	if (renamed.isErr()) {
		await afterFailure(store, place, renamed.error, now, title);
		return;
	}
	logged('A Slack session’s title could not be noted', place, await store.noteRenamed(place.id, title));
}

/**
 * The session of the thread's place in Slack set `processing`, as a message from Slack has just
 * woken it, so the member sees it was received before anything is posted. Nothing for a thread
 * with no place, or one stopped, or whose app is removed or has sessions off.
 */
export async function promptSession(store: SessionStore, botToken: string | null, threadId: string, now = new Date()): Promise<void> {
	const token = botToken === null ? null : readBotToken(botToken).unwrapOr(null);
	if (token === null) {
		return;
	}
	const found = await store.place(threadId);
	if (found.isErr()) {
		log.warn('A thread’s place in Slack could not be read to set its session', {threadId, ...serializeError(found.error)});
		return;
	}
	const place = found.value;
	if (place === null || !sessionsOn(place, now) || !sessionDue(place.session, 'processing', now)) {
		return;
	}
	const read = await store.state(threadId, now);
	const title = read.isOk() ? (read.value?.title ?? null) : null;
	await setSession(store, token, place, 'processing', title, now);
}

/**
 * The session of a place the sweep holds kept true, once what its thread said up to
 * `deliveredSeq` is posted: its status set where the thread stands differs from what was set last,
 * or `processing` is to be renewed; then renamed where the thread's title changed since it was
 * given. Nothing where the thread said more since, which is posted first, the session following the
 * messages; nor while the app's sessions are off or the place waits to try again.
 */
export async function keepSession(store: SessionStore, token: string, place: SlackSessionPlace, deliveredSeq: number, now = new Date()): Promise<void> {
	if (!sessionsOn(place, now)) {
		return;
	}
	const read = await store.state(place.threadId, now);
	if (read.isErr()) {
		log.warn('Where a thread stands could not be read to set its Slack session', {placeId: place.id, ...serializeError(read.error)});
		return;
	}
	const thread = read.value;
	if (thread === null || thread.lastSeq > deliveredSeq) {
		return;
	}
	const status = sessionStatusOf(standingOf({state: thread.state, standing: thread, alerts: thread.alerts}), thread.subAgentsAtWork);
	const due = sessionDue(place.session, status, now);
	if (due && !(await setSession(store, token, place, status, thread.title, now))) {
		return;
	}
	// A session made just now has the thread's title already.
	if (due && place.session.status === null) {
		return;
	}
	if (thread.title !== null && renameDue(place.session, thread.title)) {
		await renameTo(store, token, place, thread.title, now);
	}
}
