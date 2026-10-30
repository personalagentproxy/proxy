import {describe, expect, test} from 'bun:test';

import type {JobRow, ThreadRow} from '@proxy/db/harness';

import {afterAnswer, failureNote, subAgentEnd, subAgentStart} from './conversation';

const now = new Date('2026-10-21T10:00:00Z');
// The member's conversation, and a sub-agent started from it.
const conversation: ThreadRow = {
	id: 'thread-0',
	orgId: 'org-1',
	agentId: 'agent-1',
	personaId: 'persona-1',
	userId: 'user-1',
	parentThreadId: null,
	parentCallId: null,
	title: null,
	taskId: null,
	finishedAt: null,
	createdAt: now,
};
const sub: ThreadRow = {...conversation, id: 'thread-1', parentThreadId: 'thread-0', parentCallId: 'c0', title: 'Find the invoices', taskId: 'task-1'};
const turn: JobRow = {id: 'job-1', threadId: 'thread-0', kind: 'inference', status: 'running', entryId: null, callId: null, runAt: now, claimedBy: 'w1', attempts: 1};
const call: JobRow = {...turn, kind: 'tool', entryId: 'entry-1', callId: 'c1'};

describe('a sub-agent', () => {
	test('starts on the brief, the first thing said in its thread, with a task of the member’s run as the persona', () => {
		expect(subAgentStart(conversation, {id: 'c1', title: 'Find the invoices', brief: 'Search the mailbox.'})).toEqual({
			callId: 'c1',
			title: 'Find the invoices',
			task: {orgId: 'org-1', agentId: 'agent-1', ownerUserId: 'user-1', personaId: 'persona-1', parentId: null, title: 'Find the invoices', goal: 'Search the mailbox.', via: 'harness'},
			entries: [{kind: 'person', text: 'Search the mailbox.'}],
		});
	});

	test('keeps a long brief whole in its thread, and cut in its task', () => {
		const brief = 'x'.repeat(3000);
		const started = subAgentStart(conversation, {id: 'c1', title: 'Long', brief});

		expect(started.entries[0]?.text).toBe(brief);
		expect(started.task.goal).toHaveLength(2000);
		expect(started.task.goal.endsWith('…')).toBe(true);
	});

	test('ends with its report, which its task keeps, cut, as the outcome, and the thread it was started from is told as is', () => {
		const report = {text: 'y'.repeat(2500), isError: false};

		expect(subAgentEnd(report)).toEqual({outcome: `${'y'.repeat(1999)}…`, report});
	});

	test('ends on an answer without calls; any other answer, and any of the conversation, gets its calls’ jobs', () => {
		const plans = {c2: {runAt: now, placeholder: null}};

		expect(afterAnswer(sub, {text: 'Three invoices.', toolCalls: []}, {})).toEqual({end: {outcome: 'Three invoices.', report: {text: 'Three invoices.', isError: false}}});
		expect(afterAnswer(sub, {text: '', toolCalls: [{id: 'c2', name: 'read', arguments: '{}'}]}, plans)).toEqual({plans});
		expect(afterAnswer(conversation, {text: 'Hello', toolCalls: []}, {})).toEqual({plans: {}});
	});
});

describe('a failed job', () => {
	test('answers its call with why, as an error', () => {
		expect(failureNote('timed out')(call, sub)).toEqual({kind: 'answer', callId: 'c1', text: 'This call could not be run: timed out'});
	});

	test('of a sub-agent’s turn ends its work with the failure as its report', () => {
		expect(failureNote('Given up after 4 attempts')(turn, sub)).toEqual({
			kind: 'end',
			end: {outcome: 'The sub-agent failed: Given up after 4 attempts', report: {text: 'The sub-agent failed: Given up after 4 attempts', isError: true}},
		});
	});

	test('of the conversation’s turn answers the person, so they can go on', () => {
		expect(failureNote('The model refused the request.')(turn, conversation)).toEqual({
			kind: 'reply',
			text: 'Something went wrong on my side, so I could not answer: The model refused the request. Say something to try again.',
		});
	});

	test('of a tool job without a call leaves nothing', () => {
		expect(failureNote('boom')({...call, callId: null}, sub)).toBeNull();
	});
});
