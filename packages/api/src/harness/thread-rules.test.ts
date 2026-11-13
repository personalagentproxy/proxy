import {describe, expect, test} from 'bun:test';

import type {JobRow, ThreadRow} from '@proxy/db/harness';

import {ATTACHMENT_MARK} from '@proxy/utils/harness';

import {afterAnswer, failureNote, planCall, threadOpening} from './thread-rules';

const now = new Date('2026-10-21T10:00:00Z');
// The member's chat.
const chat: ThreadRow = {
	id: 'chat-1',
	orgId: 'org-1',
	agentId: 'agent-1',
	personaId: 'persona-1',
	userId: 'user-1',
	parentThreadId: null,
	title: null,
	taskId: null,
	harness: null,
	harnessSession: null,
	createdAt: now,
};
const turn: JobRow = {id: 'job-1', threadId: 'thread-1', kind: 'inference', status: 'running', entryId: null, callId: null, runAt: now, claimedBy: 'w1', attempts: 1};
const call: JobRow = {...turn, kind: 'tool', entryId: 'entry-1', callId: 'c1'};

describe('a thread', () => {
	test('is opened by the member’s message: titled with a line of it, its task the same piece of work, the message its goal', () => {
		expect(threadOpening(chat, {text: 'Find the **pricing review** with Dana\nand list what changed', files: []})).toEqual({
			title: 'Find the pricing review with Dana and list what changed',
			task: {
				orgId: 'org-1',
				agentId: 'agent-1',
				ownerUserId: 'user-1',
				personaId: 'persona-1',
				parentId: null,
				title: 'Find the pricing review with Dana and list what changed',
				goal: 'Find the **pricing review** with Dana\nand list what changed',
				via: 'harness',
			},
		});
	});

	test('is titled with a short cut of a long message, and its goal cut; with files alone, by their names', () => {
		const long = threadOpening(chat, {text: 'word '.repeat(700), files: []});
		expect(long.title).toHaveLength(80);
		expect(long.title.endsWith('…')).toBe(true);
		expect(long.task.goal).toHaveLength(2000);

		const files = threadOpening(chat, {text: '', files: ['pricing.md', 'chart.png']});
		expect(files.title).toBe('pricing.md, chart.png');
		expect(files.task.goal).toBe('pricing.md, chart.png');
		expect(threadOpening(chat, {text: `${ATTACHMENT_MARK}What does this say?`, files: ['pricing.md']}).title).toBe('What does this say?');
	});

	test('has a title whatever opened it: code alone by the code, marks alone by the marks', () => {
		const log = threadOpening(chat, {text: '```sh\nError: no route to host\n  at connect\n```', files: []});
		expect(log.title).toBe('Error: no route to host at connect');
		expect(log.task.title).toBe('Error: no route to host at connect');
		expect(log.task.goal).toBe('```sh\nError: no route to host\n  at connect\n```');

		expect(threadOpening(chat, {text: '***', files: []}).title).toBe('***');
		expect(threadOpening(chat, {text: '```\n```', files: []}).title).toBe('``` ```');
		expect(threadOpening(chat, {text: `${ATTACHMENT_MARK}\n\`\`\`\nrow 1\n\`\`\``, files: ['pricing.md']}).title).toBe('pricing.md');
	});

	test('keeps no mark of a file in its goal: files alone are named, and one among the words is named where it sits', () => {
		const files = threadOpening(chat, {text: `${ATTACHMENT_MARK}${ATTACHMENT_MARK}`, files: ['pricing.md', 'chart.png']});
		expect(files.title).toBe('pricing.md, chart.png');
		expect(files.task.goal).toBe('pricing.md, chart.png');

		const among = threadOpening(chat, {text: `Does ${ATTACHMENT_MARK} match ${ATTACHMENT_MARK}?`, files: ['chart.png', 'pricing.md']});
		expect(among.task.goal).toBe('Does [chart.png] match [pricing.md]?');
	});

	test('ends its turn on an answer without calls, its task finished with what it said, cut, and tells nobody; any other answer gets its calls as planned', () => {
		const plans = {c2: {kind: 'job' as const, runAt: now}};

		expect(afterAnswer({text: 'The review moved to Friday.', toolCalls: []}, {})).toEqual({end: {outcome: 'The review moved to Friday.'}});
		expect(afterAnswer({text: 'z'.repeat(2500), toolCalls: []}, {})).toEqual({end: {outcome: `${'z'.repeat(1999)}…`}});
		expect(afterAnswer({text: '', toolCalls: [{id: 'c2', name: 'script', arguments: '{}'}]}, plans)).toEqual({plans});
	});
});

describe('a call is planned', () => {
	test('as a message to the person answered at once, the call being what they read, or that it is no good', () => {
		expect(planCall({id: 'c1', name: 'send_to_person', arguments: '{"text":" Halfway. "}'}, now)).toEqual({kind: 'answer', text: 'Sent.', isError: false});
		expect(planCall({id: 'c1', name: 'send_to_person', arguments: '{}'}, now)).toEqual({kind: 'answer', text: expect.stringContaining('Give text'), isError: true});
	});

	test('as a sleep’s job due when it ends, and any other call’s job due now', () => {
		expect(planCall({id: 'c1', name: 'sleep_until', arguments: '{"seconds":60}'}, now)).toEqual({kind: 'job', runAt: new Date('2026-10-21T10:01:00Z')});
		expect(planCall({id: 'c1', name: 'sleep_until', arguments: '{}'}, now)).toEqual({kind: 'job', runAt: now});
		expect(planCall({id: 'c1', name: 'script', arguments: '{}'}, now)).toEqual({kind: 'job', runAt: now});
		// A tool the thread hasn't got: its job answers that there is no such tool.
		expect(planCall({id: 'c1', name: 'fly', arguments: '{"to":"Lisbon"}'}, now)).toEqual({kind: 'job', runAt: now});
	});
});

describe('a failed job', () => {
	test('answers its call with why, as an error', () => {
		expect(failureNote('timed out')(call)).toEqual({kind: 'answer', callId: 'c1', text: 'This call could not be run: timed out'});
	});

	test('of a turn answers the person with the failure, so they can go on, and ends the thread’s turn with it', () => {
		const text = 'Something went wrong on my side, so I could not answer: The model refused the request. Say something to try again.';
		expect(failureNote('The model refused the request.')(turn)).toEqual({kind: 'end', text, end: {outcome: text}});
	});

	test('of a wake-up’s turn is the turn’s', () => {
		expect(failureNote('boom')({...turn, kind: 'wake'})).toMatchObject({kind: 'end'});
	});

	test('of a tool job without a call leaves nothing', () => {
		expect(failureNote('boom')({...call, callId: null})).toBeNull();
	});
});
