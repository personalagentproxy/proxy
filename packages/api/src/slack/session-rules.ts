import type {ThreadStanding} from '@proxy/contracts/harness';
import type {SlackSessionMark} from '@proxy/db/slack-sessions';

import type {SessionStatus, SlackError} from './slack-api';
import {isTokenGone} from './slack-errors';

/**
 * Where a thread stands, as its Slack agent session shows it, with no Slack and no database in it
 * (https://docs.slack.dev/ai/agent-sessions): what status a thread comes to, when it is set, when
 * the session is renamed, and what Slack saying no comes to. sessions.ts sets it.
 */

/**
 * The status a thread comes to, by where it stands (harness/thread-standing.ts `standingOf`):
 * `processing` while it is in progress, its agent at work or asleep until it wakes, and while any
 * of its sub-agents still works, though its own turn ended, which Slack shows as its working
 * indicator; `suspended` where it waits for the member, as the app says `Waiting for you`, unless
 * they archived it, putting it away, which Slack can't do to a thread; otherwise `active`, done,
 * watching for alerts or archived alike, ready for the member's next message.
 */
export function sessionStatusOf(standing: ThreadStanding, thread: {subAgentsAtWork: boolean; archived: boolean}): SessionStatus {
	if (standing === 'in_progress' || thread.subAgentsAtWork) {
		return 'processing';
	}
	if (standing === 'waiting' && !thread.archived) {
		return 'suspended';
	}
	return 'active';
}

/**
 * How long `processing` is kept before it is set again: Slack moves a session from it to `active`
 * after an hour, so a thread at work longer than that is set again well before.
 */
export const RENEW_PROCESSING_MS = 45 * 60 * 1000;

/** Whether the session is to be set to `status` now: it was set to another, or to none, or `processing` long enough ago to run out soon. */
export function sessionDue(session: Pick<SlackSessionMark, 'status' | 'setAt'>, status: SessionStatus, now: Date): boolean {
	if (session.status !== status) {
		return true;
	}
	if (status !== 'processing') {
		return false;
	}
	return session.setAt === null || now.getTime() - session.setAt.getTime() >= RENEW_PROCESSING_MS;
}

/**
 * Whether the session, once made, is to be renamed to the thread's `title`: the thread has one, and
 * it is no longer the one the session was made with or last renamed to, as where a small model
 * named the thread after the session was made with a line of its first message. A title the
 * member gave the session in Slack is kept until the thread's own changes.
 */
export function renameDue(session: Pick<SlackSessionMark, 'status' | 'title'>, title: string | null): boolean {
	return session.status !== null && title !== null && title !== session.title;
}

/** Whether any session call is made for the place now: the app's sessions aren't off, and the place doesn't wait to try again. */
export function sessionsOn(place: {session: Pick<SlackSessionMark, 'retryAt'>; app: {sessionsOffUntil: Date | null}}, now: Date): boolean {
	if (place.app.sessionsOffUntil !== null && place.app.sessionsOffUntil.getTime() > now.getTime()) {
		return false;
	}
	return place.session.retryAt === null || place.session.retryAt.getTime() <= now.getTime();
}

/**
 * What Slack saying no to a session's status or title comes to: its agent features aren't there
 * for the app or its workspace, as on a plan without them; the app's token no longer works; the
 * session isn't there to rename; wait as long as it says; or anything else, to be tried again
 * later.
 */
export type SessionFailure = {kind: 'unavailable'; why: string} | {kind: 'app_gone'} | {kind: 'no_session'} | {kind: 'rate_limited'; waitMs: number} | {kind: 'retry'};

/** How long an app whose agent features aren't there makes no session calls. */
export const SESSIONS_OFF_MS = 24 * 60 * 60 * 1000;

// What Slack answers where its agent features aren't there for this app or workspace: the
// workspace without them (`feature_disabled`, as the methods' reference pages name it), the method
// unknown to it, or the app not an agent there, lacking the agent scope or not allowed to call it.
// Not all are on the methods' pages; they are the names Slack's other methods give these.
const UNAVAILABLE = [
	'feature_disabled',
	'unknown_method',
	'method_deprecated',
	'deprecated_endpoint',
	'missing_scope',
	'not_allowed_token_type',
	'not_authorized',
	'access_denied',
	'enterprise_is_restricted',
	'paid_only',
	'paid_teams_only',
];

// What `agents.sessions.rename` answers where the Slack thread has no session to rename.
const NO_SESSION = ['session_not_found'];

// How long to wait on a rate limit that doesn't say.
const RATE_LIMIT_WAIT_MS = 30_000;

/** What Slack's no to a session's status or title comes to. */
export function sessionFailure(error: SlackError): SessionFailure {
	if (error.kind === 'rate_limited') {
		return {kind: 'rate_limited', waitMs: error.retryAfterSeconds === null ? RATE_LIMIT_WAIT_MS : error.retryAfterSeconds * 1000};
	}
	if (error.kind === 'unreachable') {
		return {kind: 'retry'};
	}
	if (UNAVAILABLE.includes(error.error)) {
		return {kind: 'unavailable', why: error.error};
	}
	if (isTokenGone(error)) {
		return {kind: 'app_gone'};
	}
	if (NO_SESSION.includes(error.error)) {
		return {kind: 'no_session'};
	}
	return {kind: 'retry'};
}

// The wait before the first try again, doubled at each after, and the longest.
const RETRY_BASE_MS = 5_000;
const RETRY_MAX_MS = 5 * 60 * 1000;

/** How long to wait before trying a session's status or title again, after `attempts` failed tries in a row: 5 seconds, doubling, five minutes at most. */
export function sessionRetryMs(attempts: number): number {
	return Math.min(RETRY_BASE_MS * 2 ** Math.max(attempts - 1, 0), RETRY_MAX_MS);
}
