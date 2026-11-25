import {describe, expect, test} from 'bun:test';

import type {ThreadStanding} from '@proxy/contracts/harness';

import {renameDue, RENEW_PROCESSING_MS, sessionDue, sessionFailure, sessionRetryMs, sessionsOn, sessionStatusOf} from './session-rules';
import type {SessionStatus} from './slack-api';

describe('the status a thread comes to', () => {
	const table: Array<[ThreadStanding, boolean, SessionStatus]> = [
		['in_progress', false, 'processing'],
		['waiting', false, 'suspended'],
		['watching', false, 'active'],
		['done', false, 'active'],
		['waiting', true, 'processing'],
		['watching', true, 'processing'],
		['done', true, 'processing'],
	];
	for (const [standing, subAgentsAtWork, status] of table) {
		test(`${standing}${subAgentsAtWork ? ', with a sub-agent at work' : ''}: ${status}`, () => {
			expect(sessionStatusOf(standing, subAgentsAtWork)).toBe(status);
		});
	}
});

describe('when a status is set', () => {
	const now = new Date('2026-11-16T12:00:00Z');
	const ago = (ms: number) => new Date(now.getTime() - ms);

	test('where none was set, or another was', () => {
		expect(sessionDue({status: null, setAt: null}, 'active', now)).toBe(true);
		expect(sessionDue({status: 'processing', setAt: ago(1_000)}, 'active', now)).toBe(true);
		expect(sessionDue({status: 'active', setAt: ago(1_000)}, 'suspended', now)).toBe(true);
	});

	test('not again where it is the same, but processing once it is to be renewed', () => {
		expect(sessionDue({status: 'active', setAt: ago(2 * RENEW_PROCESSING_MS)}, 'active', now)).toBe(false);
		expect(sessionDue({status: 'processing', setAt: ago(RENEW_PROCESSING_MS - 1)}, 'processing', now)).toBe(false);
		expect(sessionDue({status: 'processing', setAt: ago(RENEW_PROCESSING_MS)}, 'processing', now)).toBe(true);
		expect(RENEW_PROCESSING_MS).toBeLessThan(60 * 60 * 1000);
	});

	test('renamed once made, where the thread’s title is no longer the one it was given', () => {
		expect(renameDue({status: 'processing', title: 'Find a train to Lyon on Friday'}, 'Train to Lyon on Friday')).toBe(true);
		expect(renameDue({status: 'processing', title: null}, 'Train to Lyon on Friday')).toBe(true);
		expect(renameDue({status: 'active', title: 'Train to Lyon on Friday'}, 'Train to Lyon on Friday')).toBe(false);
		expect(renameDue({status: null, title: null}, 'Train to Lyon on Friday')).toBe(false);
		expect(renameDue({status: 'active', title: 'Train to Lyon on Friday'}, null)).toBe(false);
	});

	test('not while the app’s sessions are off, or the place waits to try again', () => {
		const on = {session: {retryAt: null}, app: {sessionsOffUntil: null}};
		expect(sessionsOn(on, now)).toBe(true);
		expect(sessionsOn({...on, app: {sessionsOffUntil: new Date(now.getTime() + 1)}}, now)).toBe(false);
		expect(sessionsOn({...on, app: {sessionsOffUntil: ago(1)}}, now)).toBe(true);
		expect(sessionsOn({...on, session: {retryAt: new Date(now.getTime() + 1)}}, now)).toBe(false);
		expect(sessionsOn({...on, session: {retryAt: now}}, now)).toBe(true);
	});
});

describe('what Slack saying no comes to', () => {
	const refused = (error: string) => ({kind: 'refused' as const, method: 'agents.sessions.setStatus', error, problems: []});

	test('agent features not there for the app or its workspace', () => {
		expect(sessionFailure(refused('feature_disabled'))).toEqual({kind: 'unavailable', why: 'feature_disabled'});
		expect(sessionFailure(refused('unknown_method')).kind).toBe('unavailable');
		expect(sessionFailure(refused('missing_scope')).kind).toBe('unavailable');
	});

	test('a token that is gone, no session to rename, a rate limit, and anything else', () => {
		expect(sessionFailure(refused('token_revoked'))).toEqual({kind: 'app_gone'});
		expect(sessionFailure({...refused('session_not_found'), method: 'agents.sessions.rename'})).toEqual({kind: 'no_session'});
		expect(sessionFailure({kind: 'rate_limited', method: 'agents.sessions.setStatus', retryAfterSeconds: 3})).toEqual({kind: 'rate_limited', waitMs: 3_000});
		expect(sessionFailure(refused('internal_error'))).toEqual({kind: 'retry'});
		expect(sessionFailure(refused('channel_not_found'))).toEqual({kind: 'retry'});
		expect(sessionFailure({kind: 'unreachable', method: 'agents.sessions.setStatus', cause: {kind: 'timeout', url: 'https://slack.com/api/agents.sessions.setStatus', timeoutMs: 10_000}})).toEqual({
			kind: 'retry',
		});
	});

	test('tried again later each time, five minutes apart at most', () => {
		expect([1, 2, 3, 10].map(sessionRetryMs)).toEqual([5_000, 10_000, 20_000, 300_000]);
	});
});
