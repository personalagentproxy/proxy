import {describe, expect, test} from 'bun:test';

import type {AlertRow, MemberAlertRow} from '@proxy/db/alerts';

import {checkEvery, everyText, nextTime} from './alert-repeat';
import {alertArgs, alertsParagraph, describeAlert, dueText, eventLine, matches, matchText} from './alerts';

const now = new Date('2026-11-04T10:00:00Z');

const watch: AlertRow = {
	id: 'alert-1',
	orgId: 'org-1',
	userId: 'user-1',
	chatId: 'chat-1',
	threadId: 'thread-1',
	setInThreadId: 'thread-1',
	title: 'Mail from the bank',
	brief: 'Tell me what it says.',
	at: null,
	nextAt: null,
	every: null,
	timeZone: null,
	collectionId: 'emails',
	connectionIds: ['conn-a'],
	terms: ['@bank.com', 'loan'],
	split: null,
	lastMatchedAt: null,
	slackAppId: null,
	slackChannel: null,
	createdAt: now,
};

const BERLIN = 'Europe/Berlin';

describe('alertArgs', () => {
	test('a time ahead, within a year, is a timed alert, coming where it says', () => {
		const alert = alertArgs({title: 'Call Dana', brief: 'Remind them of the call.', opens: 'this_thread', at: '2026-11-04T12:00:00+01:00'}, now, BERLIN).unwrap();
		expect(alert).toEqual({kind: 'time', title: 'Call Dana', brief: 'Remind them of the call.', opens: 'this_thread', at: new Date('2026-11-04T11:00:00Z')});
		const own = alertArgs({title: 'Call Dana', brief: 'Remind them of the call.', opens: 'new_thread', at: '2026-11-04T12:00:00+01:00'}, now, BERLIN).unwrap();
		expect(own).toEqual({kind: 'time', title: 'Call Dana', brief: 'Remind them of the call.', opens: 'new_thread', at: new Date('2026-11-04T11:00:00Z'), every: null});
	});

	test('where it comes has to be said', () => {
		expect(alertArgs({title: 'T', brief: 'B', at: '2026-11-04T12:00:00Z'}, now, BERLIN).unwrapErr()).toContain('opens');
		expect(alertArgs({title: 'T', brief: 'B', opens: 'chat', at: '2026-11-04T12:00:00Z'}, now, BERLIN).unwrapErr()).toContain('opens');
	});

	test('a time a moment ago is now; one further back, or more than a year ahead, is refused', () => {
		const soon = alertArgs({title: 'T', brief: 'B', opens: 'this_thread', at: '2026-11-04T09:59:30Z'}, now, BERLIN).unwrap();
		expect(soon.kind === 'time' && soon.at).toEqual(now);
		expect(alertArgs({title: 'T', brief: 'B', opens: 'this_thread', at: '2026-11-04T09:00:00Z'}, now, BERLIN).unwrapErr()).toContain('in the past');
		expect(alertArgs({title: 'T', brief: 'B', opens: 'this_thread', at: '2028-01-01T00:00:00Z'}, now, BERLIN).unwrapErr()).toContain('more than a year');
	});

	test('a new_thread alert may repeat, by a rule kept in the person’s time zone; one that comes to its thread may not', () => {
		const weekly = alertArgs(
			{title: 'Week ahead', brief: 'Sum up my week.', opens: 'new_thread', at: '2026-11-09T09:00:00+01:00', every: 'RRULE:FREQ=WEEKLY;BYDAY=MO;BYHOUR=9;BYMINUTE=0'},
			now,
			BERLIN,
		).unwrap();
		expect(weekly.kind === 'time' && weekly.opens === 'new_thread' && weekly.every).toEqual({rule: 'FREQ=WEEKLY;BYDAY=MO;BYHOUR=9;BYMINUTE=0', timeZone: BERLIN});
		expect(alertArgs({title: 'T', brief: 'B', opens: 'this_thread', at: '2026-11-09T09:00:00Z', every: 'FREQ=DAILY'}, now, BERLIN).unwrapErr()).toContain('every is for new_thread');
		expect(alertArgs({title: 'T', brief: 'B', opens: 'new_thread', at: '2026-11-09T09:00:00Z', every: 'FREQ=MINUTELY'}, now, BERLIN).unwrapErr()).toContain('too often');
		expect(alertArgs({title: 'T', brief: 'B', opens: 'new_thread', at: '2026-11-09T09:00:00Z', every: 'whenever'}, now, BERLIN).unwrapErr()).toContain('not an RRULE');
		expect(alertArgs({title: 'T', brief: 'B', opens: 'new_thread', at: '2026-11-09T09:00:00Z', every: 'FREQ=DAILY;DTSTART=20260101T000000Z'}, now, BERLIN).unwrapErr()).toContain('without DTSTART');
	});

	test('a collection is a watch, its terms lowercased and deduplicated, its connections null for every one', () => {
		const alert = alertArgs({title: 'Bank', brief: 'Tell me.', opens: 'this_thread', collection: 'emails', terms: ['Loan', 'loan', ' Mortgage ']}, now, BERLIN).unwrap();
		expect(alert).toEqual({kind: 'watch', opens: 'this_thread', title: 'Bank', brief: 'Tell me.', collectionId: 'emails', connectionIds: null, terms: ['loan', 'mortgage']});
		const narrowed = alertArgs({title: 'Bank', brief: 'Tell me.', opens: 'this_thread', collection: 'issues', connections: ['conn-a', 'conn-a']}, now, BERLIN).unwrap();
		expect(narrowed.kind === 'watch' && narrowed.connectionIds).toEqual(['conn-a']);
	});

	test('a new_thread watch says how it splits; one that comes to its thread doesn’t, and no watch repeats', () => {
		const split = alertArgs({title: 'Bank', brief: 'Tell me.', opens: 'new_thread', collection: 'emails', split: 'per_record'}, now, BERLIN).unwrap();
		expect(split.kind === 'watch' && split.opens === 'new_thread' && split.split).toBe('per_record');
		expect(alertArgs({title: 'Bank', brief: 'Tell me.', opens: 'new_thread', collection: 'emails'}, now, BERLIN).unwrapErr()).toContain('Give split');
		expect(alertArgs({title: 'Bank', brief: 'Tell me.', opens: 'this_thread', collection: 'emails', split: 'per_check'}, now, BERLIN).unwrapErr()).toContain('split is for a new_thread watch');
		expect(alertArgs({title: 'Bank', brief: 'Tell me.', opens: 'new_thread', collection: 'emails', split: 'per_check', every: 'FREQ=DAILY'}, now, BERLIN).unwrapErr()).toContain(
			'every is for a timed alert',
		);
		expect(alertArgs({title: 'T', brief: 'B', opens: 'new_thread', at: '2026-11-09T09:00:00Z', split: 'per_check'}, now, BERLIN).unwrapErr()).toContain('split is for a watch');
	});

	test('both or neither of at and collection, a bad time, an unknown collection, no connection or no brief are refused, saying what is wrong', () => {
		const args = {title: 'T', brief: 'B', opens: 'this_thread'};
		expect(alertArgs(args, now, BERLIN).unwrapErr()).toContain('one of the two');
		expect(alertArgs({...args, at: '2026-12-01T00:00:00Z', collection: 'emails'}, now, BERLIN).unwrapErr()).toContain('one of the two');
		expect(alertArgs({...args, at: 'tomorrow'}, now, BERLIN).unwrapErr()).toContain('at');
		expect(alertArgs({...args, collection: 'files'}, now, BERLIN).unwrapErr()).toContain('collection');
		expect(alertArgs({...args, collection: 'emails', connections: []}, now, BERLIN).unwrapErr()).toContain('connections');
		expect(alertArgs({...args, brief: '  ', collection: 'emails'}, now, BERLIN).unwrapErr()).toContain('brief');
		expect(alertArgs('nothing', now, BERLIN).isErr()).toBe(true);
	});
});

describe('a repeating alert’s times', () => {
	test('keep to the wall clock of its zone across a change of the clocks', () => {
		// Mondays at 9 in Berlin: 8:00 UTC in winter, 7:00 once the clocks go forward on 29 March.
		const alert = {at: new Date('2026-03-23T08:00:00Z'), every: 'FREQ=WEEKLY;BYDAY=MO;BYHOUR=9;BYMINUTE=0', timeZone: BERLIN};
		expect(nextTime(alert, alert.at)).toEqual(new Date('2026-03-30T07:00:00Z'));
		expect(nextTime(alert, new Date('2026-03-30T07:00:00Z'))).toEqual(new Date('2026-04-06T07:00:00Z'));
	});

	test('skip those missed, and end where the rule does', () => {
		const alert = {at: new Date('2026-11-02T08:00:00Z'), every: 'FREQ=DAILY;BYHOUR=9;BYMINUTE=0', timeZone: BERLIN};
		expect(nextTime(alert, new Date('2026-11-05T12:00:00Z'))).toEqual(new Date('2026-11-06T08:00:00Z'));
		expect(nextTime({...alert, every: 'FREQ=DAILY;COUNT=2'}, new Date('2026-11-05T12:00:00Z'))).toBeNull();
	});

	test('a time skipped as the clocks go forward comes past the gap', () => {
		const alert = {at: new Date('2026-03-28T01:30:00Z'), every: 'FREQ=DAILY;BYHOUR=2;BYMINUTE=30', timeZone: BERLIN};
		expect(nextTime(alert, alert.at)).toEqual(new Date('2026-03-29T01:30:00Z'));
	});

	test('are a rule of at least an hour apart, said in words with its zone', () => {
		expect(checkEvery('FREQ=HOURLY;BYMINUTE=0,30', now, BERLIN).unwrapErr()).toContain('too often');
		expect(checkEvery('FREQ=HOURLY', now, BERLIN).unwrap()).toBe('FREQ=HOURLY');
		expect(everyText('FREQ=WEEKLY;BYDAY=MO;BYHOUR=9;BYMINUTE=0', BERLIN)).toBe('every week on Monday at 9 (Europe/Berlin)');
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
	const timed = {...watch, collectionId: null, connectionIds: [], terms: [], at: now, nextAt: now};

	test('an alert is described by its id, what it watches and its terms, or its time, and how it repeats', () => {
		expect(describeAlert(watch)).toBe('alert-1: “Mail from the bank”, watching emails in connection conn-a for “@bank.com” or “loan”');
		expect(describeAlert(timed)).toBe('alert-1: “Mail from the bank”, due 2026-11-04T10:00:00.000Z');
		expect(describeAlert({...timed, threadId: null, every: 'FREQ=WEEKLY;BYDAY=MO;BYHOUR=9;BYMINUTE=0', timeZone: BERLIN})).toBe(
			'alert-1: “Mail from the bank”, due 2026-11-04T10:00:00.000Z, then every week on Monday at 9 (Europe/Berlin)',
		);
	});

	test('a thread’s agent is told of every alert of the person’s, with the thread it comes to, or that it opens new ones and where it was set', () => {
		const mine: MemberAlertRow = {...watch, persona, thread: {id: 'thread-1', title: 'Watch the bank', slack: null}, setIn: {id: 'thread-1', title: 'Watch the bank', slack: null}};
		const morning: MemberAlertRow = {
			...timed,
			id: 'alert-2',
			threadId: 'thread-2',
			setInThreadId: 'thread-2',
			title: 'Morning check',
			persona,
			thread: {id: 'thread-2', title: 'Check the review every morning', slack: null},
			setIn: {id: 'thread-2', title: 'Check the review every morning', slack: null},
		};
		const own: MemberAlertRow = {...watch, id: 'alert-3', threadId: null, split: 'per_record', persona, thread: null, setIn: {id: 'thread-1', title: 'Watch the bank', slack: null}};

		expect(alertsParagraph([], 'thread-1')).toBe('No alerts.');
		expect(alertsParagraph([mine, morning, own], 'thread-1')).toBe(
			[
				'The person’s alerts:',
				'- alert-1: “Mail from the bank”, watching emails in connection conn-a for “@bank.com” or “loan”; comes to this thread',
				'- alert-2: “Morning check”, due 2026-11-04T10:00:00.000Z; comes to the thread “Check the review every morning”',
				'- alert-3: “Mail from the bank”, watching emails in connection conn-a for “@bank.com” or “loan”; opens a new thread each time (one for each record); set in this thread',
			].join('\n'),
		);
		expect(alertsParagraph([{...own, setIn: null}], 'thread-1')).toContain('; set in a thread since gone');
	});

	test('what matched is told with each record, its link and the brief, and, opening a new thread, where it was set', () => {
		const record = {id: 'm1', title: 'Your loan', url: 'https://mail.example.com/m1', summary: 'From dana@bank.com'};
		const text = matchText(watch, [record], null);
		expect(text).toContain('matched a new one of the emails it watches, for “@bank.com” or “loan”');
		expect(text).toContain('- Your loan (https://mail.example.com/m1) — From dana@bank.com; id m1');
		expect(text).toContain('What you noted for it: Tell me what it says.');
		expect(text).not.toContain('You set it in');
		expect(matchText({...watch, threadId: null}, [record], 'Watch the bank')).toContain('You set it in the thread “Watch the bank” (id thread-1).');
	});

	test('what an alert lands says in a line its title and what came, anything else its first line', () => {
		const record = {id: 'm1', title: 'Your loan', url: 'https://mail.example.com/m1', summary: 'From dana@bank.com'};
		expect(eventLine(matchText(watch, [record], null))).toBe('“Mail from the bank” matched a new email');
		expect(eventLine(matchText(watch, [record, {...record, id: 'm2'}], null))).toBe('“Mail from the bank” matched 2 new emails');
		expect(eventLine(matchText({...watch, collectionId: 'events'}, [record], null))).toBe('“Mail from the bank” matched a new calendar event');
		expect(eventLine(dueText(timed, null))).toBe('“Mail from the bank” is due');
		expect(eventLine('Something else\n\nwith more')).toBe('Something else');
	});

	test('a timed alert due says when it was set for, or how it repeats', () => {
		expect(dueText(timed, null)).toBe('The alert “Mail from the bank” is due now, which you set for 2026-11-04T10:00:00.000Z. What you noted for it: Tell me what it says.');
		expect(dueText({...timed, threadId: null, every: 'FREQ=DAILY;BYHOUR=9', timeZone: BERLIN}, 'Watch the bank')).toBe(
			'The alert “Mail from the bank” is due now, which you set to come every day at 9 (Europe/Berlin). You set it in the thread “Watch the bank” (id thread-1). What you noted for it: Tell me what it says.',
		);
	});
});
