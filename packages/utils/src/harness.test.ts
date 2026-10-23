import {describe, expect, test} from 'bun:test';

import {
	AVATAR_COLORS,
	AVATAR_SHAPES,
	isAvatarColor,
	isAvatarShape,
	type LogEntry,
	pendingToolCalls,
	readyForInference,
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

describe('avatars', () => {
	test('are four shapes and eight colors, told from anything else', () => {
		expect(AVATAR_SHAPES).toHaveLength(4);
		expect(AVATAR_COLORS).toHaveLength(8);
		expect(isAvatarShape('circle')).toBe(true);
		expect(isAvatarShape('star')).toBe(false);
		expect(isAvatarColor('blue')).toBe(true);
		expect(isAvatarColor('brown')).toBe(false);
	});
});
