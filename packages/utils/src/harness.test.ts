import {describe, expect, test} from 'bun:test';

import {
	AVATAR_COLORS,
	callArguments,
	cut,
	DEFAULT_LOOK,
	isAvatarColor,
	type LogEntry,
	parseHarnessSession,
	parseLook,
	pendingToolCalls,
	readyForInference,
	shuffleLook,
	parentMessageArgs,
	sleepUntil,
	subAgentArgs,
	subAgentMessageArgs,
	threadState,
	ATTACHMENT_MARK,
	attachedParts,
	keepMarks,
	preview,
} from './harness';

const person = (text: string): LogEntry => ({kind: 'person', text, toolCalls: null, callId: null});
const assistant = (text: string, calls: Array<{id: string; name: string}> = []): LogEntry => ({
	kind: 'assistant',
	text,
	toolCalls: calls.map((call) => ({...call, arguments: '{}'})),
	callId: null,
});
const result = (callId: string): LogEntry => ({
	kind: 'tool_result',
	text: 'ok',
	toolCalls: null,
	callId,
});
const event = (callId: string): LogEntry => ({
	kind: 'event',
	text: 'report',
	toolCalls: null,
	callId,
});

describe('pendingToolCalls', () => {
	test('is the last answer’s calls without a result, and none before an answer', () => {
		expect(pendingToolCalls([person('hi')])).toEqual([]);
		const log = [
			person('hi'),
			assistant('', [
				{id: 'a', name: 'read'},
				{id: 'b', name: 'read'},
			]),
			result('a'),
		];
		expect(pendingToolCalls(log).map((call) => call.id)).toEqual(['b']);
		expect(pendingToolCalls([...log, result('b')])).toEqual([]);
	});

	test('only the last answer’s calls count', () => {
		const log = [assistant('', [{id: 'a', name: 'read'}]), assistant('done')];
		expect(pendingToolCalls(log)).toEqual([]);
	});
});

describe('readyForInference', () => {
	test('after the person spoke, or every call has its result, but not after the model’s own answer', () => {
		expect(readyForInference([])).toBe(false);
		expect(readyForInference([person('hi')])).toBe(true);
		expect(readyForInference([person('hi'), assistant('hello')])).toBe(false);
		const calling = [person('hi'), assistant('', [{id: 'a', name: 'read'}])];
		expect(readyForInference(calling)).toBe(false);
		expect(readyForInference([...calling, result('a')])).toBe(true);
	});

	test('after an event, as after the person, but not while a call is still unanswered', () => {
		const delegated = [
			person('hi'),
			assistant('', [{id: 'd', name: 'create_subagent'}]),
			result('d'),
			assistant('Started.'),
		];
		expect(readyForInference(delegated)).toBe(false);
		expect(readyForInference([...delegated, event('d')])).toBe(true);
		expect(
			readyForInference([
				...delegated,
				person('and?'),
				assistant('', [{id: 'e', name: 'create_subagent'}]),
				event('d'),
			]),
		).toBe(false);
	});
});

describe('callArguments', () => {
	test('are what the model wrote, parsed, or null where that was not JSON', () => {
		expect(callArguments({id: 'c1', name: 'read', arguments: '{"tool":"list"}'})).toEqual({
			tool: 'list',
		});
		expect(callArguments({id: 'c1', name: 'read', arguments: '{"tool":'})).toBeNull();
	});
});

describe('cut', () => {
	test('keeps a text within the limit as it is, and ends a longer one with an ellipsis at the limit', () => {
		expect(cut('short', 10)).toBe('short');
		expect(cut('x'.repeat(10), 10)).toBe('x'.repeat(10));
		expect(cut('x'.repeat(11), 10)).toBe(`${'x'.repeat(9)}…`);
	});
});

describe('subAgentArgs', () => {
	test('are a title, trimmed and cut to a task’s, and a brief, or nothing', () => {
		expect(subAgentArgs({title: ' Find the invoices ', brief: ' Search the mailbox. '})).toEqual({
			title: 'Find the invoices',
			brief: 'Search the mailbox.',
		});
		expect(subAgentArgs({title: 'x'.repeat(130), brief: 'Go'})?.title).toHaveLength(120);
		expect(subAgentArgs({title: 'Find', brief: ' '})).toBeNull();
		expect(subAgentArgs({brief: 'Go'})).toBeNull();
		expect(subAgentArgs('go')).toBeNull();
	});
});

describe('subAgentMessageArgs and parentMessageArgs', () => {
	test('are which sub-agent and the message, trimmed, or the message alone, or nothing', () => {
		expect(subAgentMessageArgs({subagent: ' sub-1 ', text: ' Also the shared mailbox. '})).toEqual({
			subagent: 'sub-1',
			text: 'Also the shared mailbox.',
		});
		expect(subAgentMessageArgs({subagent: 'sub-1'})).toBeNull();
		expect(subAgentMessageArgs({subagent: '', text: 'Go'})).toBeNull();
		expect(subAgentMessageArgs(['sub-1', 'Go'])).toBeNull();
		expect(parentMessageArgs({text: ' Which mailbox? '})).toEqual({text: 'Which mailbox?'});
		expect(parentMessageArgs({text: ' '})).toBeNull();
		expect(parentMessageArgs(null)).toBeNull();
	});
});

describe('threadState', () => {
	const now = new Date('2026-10-21T10:00:00Z');
	const later = new Date('2026-10-21T11:00:00Z');

	test('is stopped with no job, asleep while every job is a sleep due later, and at work otherwise, a turn due later included', () => {
		expect(threadState([], now)).toEqual({kind: 'stopped'});
		expect(threadState([{kind: 'tool', runAt: later}], now)).toEqual({
			kind: 'asleep',
			until: later,
		});
		expect(
			threadState(
				[
					{kind: 'tool', runAt: new Date('2026-10-21T12:00:00Z')},
					{kind: 'tool', runAt: later},
				],
				now,
			),
		).toEqual({kind: 'asleep', until: later});
		expect(
			threadState(
				[
					{kind: 'tool', runAt: later},
					{kind: 'inference', runAt: later},
				],
				now,
			),
		).toEqual({kind: 'working'});
		expect(threadState([{kind: 'tool', runAt: now}], now)).toEqual({kind: 'working'});
	});

	test('a wake job due later is a sleep too, whichever harness answered the sleep', () => {
		expect(threadState([{kind: 'wake', runAt: later}], now)).toEqual({
			kind: 'asleep',
			until: later,
		});
		expect(
			threadState(
				[
					{kind: 'wake', runAt: later},
					{kind: 'tool', runAt: new Date('2026-10-21T12:00:00Z')},
				],
				now,
			),
		).toEqual({kind: 'asleep', until: later});
		expect(threadState([{kind: 'wake', runAt: now}], now)).toEqual({kind: 'working'});
		expect(
			threadState(
				[
					{kind: 'wake', runAt: later},
					{kind: 'inference', runAt: later},
				],
				now,
			),
		).toEqual({kind: 'working'});
	});
});

describe('parseHarnessSession', () => {
	test('is the session from its JSON, or null for none, nonsense or not a session', () => {
		expect(parseHarnessSession('{"id":"s1","state":{"lastSeq":4,"tags":["a"]}}')).toEqual({
			id: 's1',
			state: {lastSeq: 4, tags: ['a']},
		});
		expect(parseHarnessSession('{"id":"s1","state":null}')).toEqual({id: 's1', state: null});
		expect(parseHarnessSession(null)).toBeNull();
		expect(parseHarnessSession('not json')).toBeNull();
		expect(parseHarnessSession('{"id":4,"state":{}}')).toBeNull();
		expect(parseHarnessSession('{"id":"s1"}')).toBeNull();
	});
});

describe('sleepUntil', () => {
	const now = new Date('2026-10-21T10:00:00Z');

	test('takes a time or seconds from now, never in the past and at most a week', () => {
		expect(sleepUntil({until: '2026-10-21T10:05:00Z'}, now)).toEqual(
			new Date('2026-10-21T10:05:00Z'),
		);
		expect(sleepUntil({seconds: 120}, now)).toEqual(new Date('2026-10-21T10:02:00Z'));
		expect(sleepUntil({until: '2026-10-21T09:00:00Z'}, now)).toEqual(now);
		expect(sleepUntil({seconds: 60 * 60 * 24 * 30}, now)).toEqual(new Date('2026-10-28T10:00:00Z'));
	});

	test('is null for anything else', () => {
		expect(sleepUntil({until: 'tomorrow'}, now)).toBeNull();
		expect(sleepUntil({}, now)).toBeNull();
		expect(sleepUntil('soon', now)).toBeNull();
	});
});

describe('heads', () => {
	test('are one of nine colors, told from anything else', () => {
		expect(AVATAR_COLORS).toHaveLength(9);
		expect(isAvatarColor('blue')).toBe(true);
		expect(isAvatarColor('brown')).toBe(false);
	});

	test('a look is read from its JSON, and the default stands in for none or nonsense', () => {
		const look = {nose: 0.5, noseOut: 0.3, eye: 30, eyeTheta: 60, eyeLat: 4, eyes: 1 as const};
		expect(parseLook(JSON.stringify(look))).toEqual(look);
		expect(parseLook(null)).toEqual(DEFAULT_LOOK);
		expect(parseLook('{"nose":9}')).toEqual(DEFAULT_LOOK);
		expect(parseLook('not json')).toEqual(DEFAULT_LOOK);
	});

	test('a shuffled look is within the family’s range, rounded as the lab rounds, with two eyes', () => {
		const low = shuffleLook(() => 0);
		const high = shuffleLook(() => 0.999999);
		expect(low).toEqual({nose: 0.4, noseOut: 0.2, eye: 22, eyeTheta: 45, eyeLat: -8, eyes: 2});
		expect(high).toEqual({nose: 0.58, noseOut: 0.6, eye: 34, eyeTheta: 70, eyeLat: 20, eyes: 2});
		expect(parseLook(JSON.stringify(shuffleLook()))).not.toEqual(DEFAULT_LOOK);
	});
});

describe('attachedParts', () => {
	const mark = ATTACHMENT_MARK;

	test('cuts what was typed at its files, each where its mark is, in the order of the files', () => {
		expect(attachedParts(`Does ${mark} match ${mark}?`, ['a', 'b'])).toEqual([
			{text: 'Does '},
			{file: 'a'},
			{text: ' match '},
			{file: 'b'},
			{text: '?'},
		]);
		expect(attachedParts(`${mark}${mark} both`, ['a', 'b'])).toEqual([
			{file: 'a'},
			{file: 'b'},
			{text: ' both'},
		]);
		expect(attachedParts('Nothing attached', [])).toEqual([{text: 'Nothing attached'}]);
	});

	test('puts files without a mark first, as a message from before files sat among the words has them, and drops marks without a file', () => {
		expect(attachedParts('What do these say?', ['a', 'b'])).toEqual([
			{file: 'a'},
			{file: 'b'},
			{text: 'What do these say?'},
		]);
		expect(attachedParts(`See ${mark} here`, ['a', 'b'])).toEqual([
			{file: 'b'},
			{text: 'See '},
			{file: 'a'},
			{text: ' here'},
		]);
		expect(attachedParts(`See ${mark} and ${mark}`, ['a'])).toEqual([
			{text: 'See '},
			{file: 'a'},
			{text: ' and '},
		]);
		expect(attachedParts('', ['a'])).toEqual([{file: 'a'}]);
	});

	test('keepMarks takes out the marks beyond the files there are', () => {
		expect(keepMarks(`a${mark}b${mark}c${mark}`, 2)).toBe(`a${mark}b${mark}c`);
		expect(keepMarks(`a${mark}b`, 0)).toBe('ab');
		expect(keepMarks('plain', 3)).toBe('plain');
	});

	test('a preview of a message shows a picture as what it shows', () => {
		expect(
			preview(
				'Here: ![Revenue by month](https://app.example.com/a/connections/d?file=f) and ![](https://x.example.com/p.png)',
			),
		).toBe('Here: Revenue by month and Picture');
	});

	test('a preview of a message says nothing of where its files are', () => {
		expect(preview(`Does ${mark} match ${mark}?`)).toBe('Does match ?');
	});
});
