import {describe, expect, test} from 'bun:test';

import {ApiErr} from '@proxy/utils';

import type {HarnessEvent} from './backend';
import {harnessConformance, type ScriptedModel} from './conformance';
import {fakeHarness, fakeToolSurface} from './fake';

// The fake, scripted as the conformance tests script a model: an answer as the events a harness
// would yield for it, out of reach as a failure worth trying again.
harnessConformance('the fake harness', () => {
	const harness = fakeHarness();
	const scripted: ScriptedModel = {
		answers: ({text, toolCalls}) => {
			const words: HarnessEvent[] = text === '' ? [] : [{kind: 'text', text}];
			const calls: HarnessEvent[] = toolCalls.map((call) => ({kind: 'tool_call', ...call}));
			harness.script([...words, ...calls, {kind: 'done', session: null, system: 'You are a test.', inputTokens: 10, outputTokens: 2}]);
		},
		unreachable: () => {
			harness.script([{kind: 'failed', error: ApiErr.providerUnreachable(new Error('down')), retry: true}]);
		},
	};
	return {harness, scripted};
});

describe('fakeHarness', () => {
	test('yields what it was scripted, one list per turn, keeps every turn it was given, and ends an unscripted turn with done', async () => {
		const harness = fakeHarness();
		harness.script([{kind: 'text', text: 'One'}]);
		const input = {
			thread: {id: 'thread-1', parentThreadId: null},
			session: null,
			entries: [],
			woken: false,
			system: 'You are a test.',
			tools: fakeToolSurface([]),
			model: 'claude',
			maxSteps: 1,
			signal: new AbortController().signal,
		};

		expect(await Array.fromAsync(harness.turn(input))).toEqual([{kind: 'text', text: 'One'}]);
		expect(await Array.fromAsync(harness.turn({...input, system: 'Second'}))).toEqual([{kind: 'done', session: null, system: 'Second', inputTokens: 0, outputTokens: 0}]);
		expect(harness.turns.map((turn) => turn.system)).toEqual(['You are a test.', 'Second']);
	});

	test('the fake tool surface records every call and answers each the same', async () => {
		const surface = fakeToolSurface([], {text: 'rows', isError: false});

		expect((await surface.execute({id: 'c1', name: 'read', arguments: '{}'})).unwrap()).toEqual({text: 'rows', isError: false});
		expect(surface.calls).toEqual([{id: 'c1', name: 'read', arguments: '{}'}]);
	});
});
