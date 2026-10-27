import {describe, expect, test} from 'bun:test';

import {
	AVATAR_COLORS,
	DEFAULT_LOOK,
	delegateArgs,
	isAvatarColor,
	type LogEntry,
	parseLook,
	pendingToolCalls,
	readyForInference,
	shuffleLook,
	sleepUntil,
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
			assistant('', [{id: 'd', name: 'delegate'}]),
			result('d'),
			assistant('Started.'),
		];
		expect(readyForInference(delegated)).toBe(false);
		expect(readyForInference([...delegated, event('d')])).toBe(true);
		expect(
			readyForInference([
				...delegated,
				person('and?'),
				assistant('', [{id: 'e', name: 'delegate'}]),
				event('d'),
			]),
		).toBe(false);
	});
});

describe('delegateArgs', () => {
	test('are a title, trimmed and cut to a task’s, and a brief, or nothing', () => {
		expect(delegateArgs({title: ' Find the invoices ', brief: ' Search the mailbox. '})).toEqual({
			title: 'Find the invoices',
			brief: 'Search the mailbox.',
		});
		expect(delegateArgs({title: 'x'.repeat(130), brief: 'Go'})?.title).toHaveLength(120);
		expect(delegateArgs({title: 'Find', brief: ' '})).toBeNull();
		expect(delegateArgs({brief: 'Go'})).toBeNull();
		expect(delegateArgs('go')).toBeNull();
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
	test('are one of eight colors, told from anything else', () => {
		expect(AVATAR_COLORS).toHaveLength(8);
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
