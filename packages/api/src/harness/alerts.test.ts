import {describe, expect, test} from 'bun:test';

import type {AlertRow} from '@proxy/db/alerts';

import {alertArgs, alertsParagraph, describeAlert, matches, matchText} from './alerts';

const now = new Date('2026-11-04T10:00:00Z');

const watch: AlertRow = {
	id: 'alert-1',
	orgId: 'org-1',
	userId: 'user-1',
	threadId: 'thread-1',
	title: 'Mail from the bank',
	brief: 'Tell me what it says.',
	at: null,
	collectionId: 'emails',
	connectionIds: ['conn-a'],
	terms: ['@bank.com', 'loan'],
	lastMatchedAt: null,
	createdAt: now,
};

describe('alertArgs', () => {
	test('a time ahead, within a year, is a timed alert', () => {
		const alert = alertArgs({title: 'Call Dana', brief: 'Remind them of the call.', at: '2026-11-04T12:00:00+01:00'}, now).unwrap();
		expect(alert).toEqual({kind: 'time', title: 'Call Dana', brief: 'Remind them of the call.', at: new Date('2026-11-04T11:00:00Z')});
	});

	test('a time a moment ago is now; one further back, or more than a year ahead, is refused', () => {
		const soon = alertArgs({title: 'T', brief: 'B', at: '2026-11-04T09:59:30Z'}, now).unwrap();
		expect(soon.kind === 'time' && soon.at).toEqual(now);
		expect(alertArgs({title: 'T', brief: 'B', at: '2026-11-04T09:00:00Z'}, now).unwrapErr()).toContain('in the past');
		expect(alertArgs({title: 'T', brief: 'B', at: '2028-01-01T00:00:00Z'}, now).unwrapErr()).toContain('more than a year');
	});

	test('a collection is a watch, its terms lowercased and deduplicated, its connections null for every one', () => {
		const alert = alertArgs({title: 'Bank', brief: 'Tell me.', collection: 'emails', terms: ['Loan', 'loan', ' Mortgage ']}, now).unwrap();
		expect(alert).toEqual({kind: 'watch', title: 'Bank', brief: 'Tell me.', collectionId: 'emails', connectionIds: null, terms: ['loan', 'mortgage']});
		const narrowed = alertArgs({title: 'Bank', brief: 'Tell me.', collection: 'issues', connections: ['conn-a', 'conn-a']}, now).unwrap();
		expect(narrowed.kind === 'watch' && narrowed.connectionIds).toEqual(['conn-a']);
	});

	test('both or neither of at and collection, a bad time, an unknown collection, no connection or no brief are refused, saying what is wrong', () => {
		expect(alertArgs({title: 'T', brief: 'B'}, now).unwrapErr()).toContain('one of the two');
		expect(alertArgs({title: 'T', brief: 'B', at: '2026-12-01T00:00:00Z', collection: 'emails'}, now).unwrapErr()).toContain('one of the two');
		expect(alertArgs({title: 'T', brief: 'B', at: 'tomorrow'}, now).unwrapErr()).toContain('at');
		expect(alertArgs({title: 'T', brief: 'B', collection: 'files'}, now).unwrapErr()).toContain('collection');
		expect(alertArgs({title: 'T', brief: 'B', collection: 'emails', connections: []}, now).unwrapErr()).toContain('connections');
		expect(alertArgs({title: 'T', brief: '  ', collection: 'emails'}, now).unwrapErr()).toContain('brief');
		expect(alertArgs('nothing', now).isErr()).toBe(true);
	});
});

describe('matches', () => {
	const change = {id: 'm1', title: 'Your loan application', url: null, summary: 'From Dana <dana@bank.com> · to me@example.com'};

	test('any term in the title or the summary, whatever the case, matches; none matches everything', () => {
		expect(matches(['@BANK.com'], change)).toBe(true);
		expect(matches(['loan application'], change)).toBe(true);
		expect(matches(['mortgage'], change)).toBe(false);
		expect(matches([], change)).toBe(true);
	});
});

describe('the words', () => {
	test('an alert is described by its id, what it watches and its terms, or its time', () => {
		expect(describeAlert(watch)).toBe('alert-1: “Mail from the bank”, watching emails in connection conn-a for “@bank.com” or “loan”');
		expect(describeAlert({...watch, collectionId: null, connectionIds: [], terms: [], at: now})).toBe('alert-1: “Mail from the bank”, due 2026-11-04T10:00:00.000Z');
	});

	test('a thread’s agent is told of every alert of the person’s, each with the thread it comes to: its own, or another by its title', () => {
		const persona = {
			id: 'persona-1',
			name: 'General',
			look: {nose: 0.5, noseOut: 0.3, eye: 25, eyeTheta: 50, eyeLat: 8, eyes: 2 as const},
			color: 'teal' as const,
			harness: 'proxy',
			chatModel: 'claude',
			ownerUserId: null,
			createdById: null,
			createdAt: now,
		};
		const mine = {...watch, persona, threadTitle: 'Watch the bank'};
		const morning = {
			...watch,
			id: 'alert-2',
			threadId: 'thread-2',
			title: 'Morning check',
			collectionId: null,
			connectionIds: [],
			terms: [],
			at: now,
			persona,
			threadTitle: 'Check the review every morning',
		};

		expect(alertsParagraph([], 'thread-1')).toBe('No alerts.');
		expect(alertsParagraph([mine, morning], 'thread-1')).toBe(
			[
				'The person’s alerts, each of which comes to the thread it was set in:',
				'- alert-1: “Mail from the bank”, watching emails in connection conn-a for “@bank.com” or “loan”; set in this thread',
				'- alert-2: “Morning check”, due 2026-11-04T10:00:00.000Z; set in the thread “Check the review every morning”',
			].join('\n'),
		);
		expect(alertsParagraph([{...morning, threadTitle: null}], 'thread-1')).toContain('; set in another thread');
	});

	test('what matched is told with each record, its link and the brief', () => {
		const text = matchText(watch, [{id: 'm1', title: 'Your loan', url: 'https://mail.example.com/m1', summary: 'From dana@bank.com'}]);
		expect(text).toContain('matched a new one of the emails it watches, for “@bank.com” or “loan”');
		expect(text).toContain('- Your loan (https://mail.example.com/m1) — From dana@bank.com; id m1');
		expect(text).toContain('What you noted for it: Tell me what it says.');
	});
});
