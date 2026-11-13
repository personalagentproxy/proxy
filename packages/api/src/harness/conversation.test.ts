import {describe, expect, test} from 'bun:test';

import type {JobRow, SubAgentRow, ThreadRow} from '@proxy/db/harness';

import {ATTACHMENT_MARK} from '@proxy/utils/harness';

import {afterAnswer, failureNote, planCall, STOPPED_NOTE, subAgentStart, subAgentStop, threadOpening} from './conversation';

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
	harness: null,
	harnessSession: null,
	createdAt: now,
};
const sub: ThreadRow = {...conversation, id: 'thread-1', parentThreadId: 'thread-0', parentCallId: 'c0', title: 'Find the invoices', taskId: 'task-1'};
// A thread of the member's chat, which their message opened: no call started it.
const opened: ThreadRow = {...conversation, id: 'thread-2', parentThreadId: 'thread-0', title: 'Pricing review with Dana', taskId: 'task-2'};
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

	test('stops with what it said, which its task keeps, cut, as the outcome, and the thread it was started from is told, with the note that it stopped, or without it where it goes on', () => {
		const said = {text: 'y'.repeat(2500), isError: false};

		expect(subAgentStop(said)).toEqual({outcome: `${'y'.repeat(1999)}…`, stopped: {text: `${said.text}\n\n${STOPPED_NOTE}`, isError: false}, goingOn: said});
	});

	test('stops on an answer without calls; any other answer, and any of the conversation, gets its calls as planned', () => {
		const plans = {c2: {kind: 'job' as const, runAt: now}};

		expect(afterAnswer(sub, {text: 'Three invoices.', toolCalls: []}, {})).toEqual({stop: subAgentStop({text: 'Three invoices.', isError: false})});
		expect(afterAnswer(sub, {text: '', toolCalls: [{id: 'c2', name: 'read', arguments: '{}'}]}, plans)).toEqual({plans});
		expect(afterAnswer(conversation, {text: 'Hello', toolCalls: []}, {})).toEqual({plans: {}});
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
		expect(plan.started('thread-9')).toBe('Started “Find the invoices”, id thread-9.');
		expect(planCall(conversation, {...call, arguments: '{"title":"Find"}'}, now)).toEqual({kind: 'answer', text: expect.stringContaining('Give title'), isError: true});
		expect(planCall(sub, call, now)).toEqual({kind: 'job', runAt: now});
	});

	test('as a message to the agent a sub-agent works for, sent at once; as a job from the conversation', () => {
		const call = {id: 'c1', name: 'send_to_parent', arguments: '{"text":" Which mailbox? "}'};
		expect(planCall(sub, call, now)).toEqual({kind: 'send_to_parent', message: {text: 'Which mailbox?', isError: false}, sent: 'Sent.'});
		expect(planCall(sub, {...call, arguments: '{}'}, now)).toEqual({kind: 'answer', text: expect.stringContaining('Give text'), isError: true});
		expect(planCall(conversation, call, now)).toEqual({kind: 'job', runAt: now});
	});

	test('as a message to a sub-agent, sent at once and said as the brief was, answered with what it was up to; as a job from a sub-agent', () => {
		const call = {id: 'c1', name: 'send_to_subagent', arguments: '{"subagent":" thread-1 ","text":" Also check the shared mailbox. "}'};
		const plan = planCall(conversation, call, now);
		if (plan.kind !== 'send_to_subagent') {
			throw new Error(`expected a message to a sub-agent, got ${plan.kind}`);
		}
		expect(plan.subAgentId).toBe('thread-1');
		expect(plan.entry).toEqual({kind: 'person', text: 'Also check the shared mailbox.'});
		const was = (state: SubAgentRow['state']): SubAgentRow => ({...sub, state});
		expect(plan.sent(was({kind: 'stopped'}))).toEqual({text: expect.stringContaining('“Find the invoices”, which had stopped, and takes it up'), isError: false});
		expect(plan.sent(was({kind: 'asleep', until: now}))).toEqual({text: expect.stringContaining('was asleep, and is woken by it'), isError: false});
		expect(plan.sent(was({kind: 'working'}))).toEqual({text: expect.stringContaining('is at work, and reads it when its current call is answered'), isError: false});
		expect(plan.sent(null)).toEqual({text: expect.stringContaining('No sub-agent thread-1'), isError: true});
		expect(planCall(conversation, {...call, arguments: '{"subagent":"thread-1"}'}, now)).toEqual({kind: 'answer', text: expect.stringContaining('Give subagent'), isError: true});
		expect(planCall(sub, call, now)).toEqual({kind: 'job', runAt: now});
	});

	test('as a sub-agent’s sleep’s job due when it ends, and any other call’s job due now', () => {
		expect(planCall(sub, {id: 'c1', name: 'sleep_until', arguments: '{"seconds":60}'}, now)).toEqual({kind: 'job', runAt: new Date('2026-10-21T10:01:00Z')});
		expect(planCall(sub, {id: 'c1', name: 'sleep_until', arguments: '{}'}, now)).toEqual({kind: 'job', runAt: now});
		expect(planCall(sub, {id: 'c1', name: 'read', arguments: '{}'}, now)).toEqual({kind: 'job', runAt: now});
	});
});

describe('a failed job', () => {
	test('answers its call with why, as an error', () => {
		expect(failureNote('timed out')(call, sub)).toEqual({kind: 'answer', callId: 'c1', text: 'This call could not be run: timed out'});
	});

	test('of a sub-agent’s turn stops it with the failure as what it said', () => {
		expect(failureNote('Given up after 4 attempts')(turn, sub)).toEqual({
			kind: 'stop',
			stop: subAgentStop({text: 'The sub-agent failed: Given up after 4 attempts', isError: true}),
		});
	});

	test('of the conversation’s turn answers the person, so they can go on', () => {
		expect(failureNote('The model refused the request.')(turn, conversation)).toEqual({
			kind: 'reply',
			text: 'Something went wrong on my side, so I could not answer: The model refused the request. Say something to try again.',
		});
	});

	test('of a wake-up’s turn is the turn’s: the sub-agent stops with the failure, the person is answered with it', () => {
		const woken: JobRow = {...turn, kind: 'wake'};
		expect(failureNote('boom')(woken, sub)).toEqual({kind: 'stop', stop: subAgentStop({text: 'The sub-agent failed: boom', isError: true})});
		expect(failureNote('boom')(woken, conversation)).toMatchObject({kind: 'reply'});
	});

	test('of a tool job without a call leaves nothing', () => {
		expect(failureNote('boom')({...call, callId: null}, sub)).toBeNull();
	});
});

describe('a chat’s thread', () => {
	test('is opened by the member’s message: titled with a line of it, its task the same piece of work, the message its goal', () => {
		expect(threadOpening(conversation, {text: 'Find the **pricing review** with Dana\nand list what changed', files: []})).toEqual({
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

	test('is titled with a short cut of a long message, and its goal cut as a brief is; with files alone, by their names', () => {
		const long = threadOpening(conversation, {text: 'word '.repeat(700), files: []});
		expect(long.title).toHaveLength(80);
		expect(long.title.endsWith('…')).toBe(true);
		expect(long.task.goal).toHaveLength(2000);

		const files = threadOpening(conversation, {text: '', files: ['pricing.md', 'chart.png']});
		expect(files.title).toBe('pricing.md, chart.png');
		expect(files.task.goal).toBe('pricing.md, chart.png');
		expect(threadOpening(conversation, {text: `${ATTACHMENT_MARK}What does this say?`, files: ['pricing.md']}).title).toBe('What does this say?');
	});

	test('ends its turn on an answer without calls, its task finished with what it said, cut, and tells nobody; any other answer gets its calls as planned', () => {
		const plans = {c2: {kind: 'job' as const, runAt: now}};

		expect(afterAnswer(opened, {text: 'The review moved to Friday.', toolCalls: []}, {})).toEqual({end: {outcome: 'The review moved to Friday.'}});
		expect(afterAnswer(opened, {text: 'z'.repeat(2500), toolCalls: []}, {})).toEqual({end: {outcome: `${'z'.repeat(1999)}…`}});
		expect(afterAnswer(opened, {text: '', toolCalls: [{id: 'c2', name: 'script', arguments: '{}'}]}, plans)).toEqual({plans});
	});

	test('has its message to the person answered at once, the call being what they read; its sleep’s job due when it ends; and no sub-agents or parent', () => {
		expect(planCall(opened, {id: 'c1', name: 'send_to_person', arguments: '{"text":" Halfway. "}'}, now)).toEqual({kind: 'answer', text: 'Sent.', isError: false});
		expect(planCall(opened, {id: 'c1', name: 'send_to_person', arguments: '{}'}, now)).toEqual({kind: 'answer', text: expect.stringContaining('Give text'), isError: true});
		expect(planCall(opened, {id: 'c1', name: 'sleep_until', arguments: '{"seconds":60}'}, now)).toEqual({kind: 'job', runAt: new Date('2026-10-21T10:01:00Z')});
		for (const name of ['create_subagent', 'send_to_subagent', 'send_to_parent']) {
			expect(planCall(opened, {id: 'c1', name, arguments: '{"title":"a","brief":"b","subagent":"thread-1","text":"Hi"}'}, now)).toEqual({kind: 'job', runAt: now});
		}
		// The others have no message to the person: its job answers that there is no such tool.
		expect(planCall(conversation, {id: 'c1', name: 'send_to_person', arguments: '{"text":"Hi"}'}, now)).toEqual({kind: 'job', runAt: now});
		expect(planCall(sub, {id: 'c1', name: 'send_to_person', arguments: '{"text":"Hi"}'}, now)).toEqual({kind: 'job', runAt: now});
	});

	test('whose turn failed answers the person with the failure, as their conversation does, and ends its turn with it', () => {
		const text = 'Something went wrong on my side, so I could not answer: The model refused the request. Say something to try again.';
		expect(failureNote('The model refused the request.')(turn, opened)).toEqual({kind: 'end', text, end: {outcome: text}});
		expect(failureNote('boom')({...turn, kind: 'wake'}, opened)).toMatchObject({kind: 'end'});
		expect(failureNote('timed out')(call, opened)).toEqual({kind: 'answer', callId: 'c1', text: 'This call could not be run: timed out'});
	});
});
