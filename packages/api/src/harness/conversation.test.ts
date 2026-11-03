import {describe, expect, test} from 'bun:test';

import type {JobRow, ThreadRow} from '@proxy/db/harness';

import {afterAnswer, failureNote, planCall, STOPPED_NOTE, subAgentMessage, subAgentStart, subAgentStop} from './conversation';

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

	test('stops with what it said, which its task keeps, cut, as the outcome, and the thread it was started from is told, with the note that it stopped', () => {
		const said = {text: 'y'.repeat(2500), isError: false};

		expect(subAgentStop(said)).toEqual({outcome: `${'y'.repeat(1999)}…`, said: {text: `${said.text}\n\n${STOPPED_NOTE}`, isError: false}});
	});

	test('stops on an answer without calls; any other answer, and any of the conversation, gets its calls as planned', () => {
		const plans = {c2: {kind: 'job' as const, runAt: now}};

		expect(afterAnswer(sub, {text: 'Three invoices.', toolCalls: []}, {})).toEqual({stop: {outcome: 'Three invoices.', said: {text: `Three invoices.\n\n${STOPPED_NOTE}`, isError: false}}});
		expect(afterAnswer(sub, {text: '', toolCalls: [{id: 'c2', name: 'read', arguments: '{}'}]}, plans)).toEqual({plans});
		expect(afterAnswer(conversation, {text: 'Hello', toolCalls: []}, {})).toEqual({plans: {}});
	});

	test('is sent a message as the brief was said, with what a sleep it cuts short is answered', () => {
		expect(subAgentMessage('Also the shared mailbox.', now)).toEqual({
			entry: {kind: 'person', text: 'Also the shared mailbox.'},
			wokenEarly: 'You were woken before the time you asked for, by a message; it is now 2026-10-21T10:00:00.000Z.',
		});
	});
});

describe('a call is planned', () => {
	test('as a sub-agent started at once, answered with its id, from the conversation; as a job with no such tool from a sub-agent', () => {
		const call = {id: 'c1', name: 'create_subagent', arguments: '{"title":" Find the invoices ","brief":"Search the mailbox."}'};
		const plan = planCall(conversation, call, now);
		if (plan.kind !== 'create_subagent') {
			throw new Error(`expected a sub-agent started, got ${plan.kind}`);
		}
		expect(plan.start).toEqual(subAgentStart(conversation, {id: 'c1', title: 'Find the invoices', brief: 'Search the mailbox.'}));
		expect(plan.started('thread-9')).toBe('Started the sub-agent “Find the invoices”, id thread-9. What it says will come to you as a message.');
		expect(planCall(conversation, {...call, arguments: '{"title":"Find"}'}, now)).toEqual({kind: 'answer', text: expect.stringContaining('Give title'), isError: true});
		expect(planCall(sub, call, now)).toEqual({kind: 'job', runAt: now});
	});

	test('as a message to the agent a sub-agent works for, sent at once; as a job from the conversation', () => {
		const call = {id: 'c1', name: 'send_to_parent', arguments: '{"text":" Which mailbox? "}'};
		expect(planCall(sub, call, now)).toEqual({kind: 'send_to_parent', message: {text: 'Which mailbox?', isError: false}, sent: expect.stringContaining('Sent to the agent you work for')});
		expect(planCall(sub, {...call, arguments: '{}'}, now)).toEqual({kind: 'answer', text: expect.stringContaining('Give text'), isError: true});
		expect(planCall(conversation, call, now)).toEqual({kind: 'job', runAt: now});
	});

	test('as a sub-agent’s sleep’s job due when it ends, and any other call’s job due now', () => {
		expect(planCall(sub, {id: 'c1', name: 'sleep_until', arguments: '{"seconds":60}'}, now)).toEqual({kind: 'job', runAt: new Date('2026-10-21T10:01:00Z')});
		expect(planCall(sub, {id: 'c1', name: 'sleep_until', arguments: '{}'}, now)).toEqual({kind: 'job', runAt: now});
		expect(planCall(sub, {id: 'c1', name: 'read', arguments: '{}'}, now)).toEqual({kind: 'job', runAt: now});
		expect(planCall(conversation, {id: 'c1', name: 'send_to_subagent', arguments: '{"subagent":"x","text":"Go"}'}, now)).toEqual({kind: 'job', runAt: now});
	});
});

describe('a failed job', () => {
	test('answers its call with why, as an error', () => {
		expect(failureNote('timed out')(call, sub)).toEqual({kind: 'answer', callId: 'c1', text: 'This call could not be run: timed out'});
	});

	test('of a sub-agent’s turn stops it with the failure as what it said', () => {
		expect(failureNote('Given up after 4 attempts')(turn, sub)).toEqual({
			kind: 'stop',
			stop: {outcome: 'The sub-agent failed: Given up after 4 attempts', said: {text: `The sub-agent failed: Given up after 4 attempts\n\n${STOPPED_NOTE}`, isError: true}},
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
