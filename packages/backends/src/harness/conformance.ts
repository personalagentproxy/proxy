import {describe, expect, test} from 'bun:test';

import type {HarnessBackend, HarnessEvent, HarnessTurn} from './backend';
import {fakeToolSurface} from './fake';

/**
 * What every harness has to do, as tests: a harness's own test file calls `harnessConformance`
 * with how to make one, scripted, so the tests can say what the model answers without a model.
 * The tests are about the grammar of a turn (backend.ts): what the events are, in what order, and
 * that a turn ends.
 */

/** How a test tells the harness under test what its model does next: answer with words and calls, or be out of reach. */
export type ScriptedModel = {
	answers: (answer: {text: string; toolCalls: Array<{id: string; name: string; arguments: string}>}) => void;
	unreachable: () => void;
};

// How long a turn may take in these tests, where the model answers at once.
const TURN_MS = 2_000;

const TOOLS = [
	{name: 'read', description: 'Reads', inputSchema: {type: 'object', properties: {}}, readOnly: true},
	{name: 'run', description: 'Runs', inputSchema: {type: 'object', properties: {}}, readOnly: false},
];

const ENTRIES = [{kind: 'person' as const, text: 'Hi', toolCalls: null, callId: null, isError: false, seq: 1, coversSeq: null, inputTokens: null}];

const TERMINAL = new Set<HarnessEvent['kind']>(['done', 'failed']);

// A usage event may come any time before the terminal event; it is not one.
const USAGE_WINDOWS = new Set(['fiveHour', 'sevenDay']);

// A turn's input, with the signal given or one never aborted. A credential is given, as the api
// gives one to a harness chosen for it; a harness that runs with the server's key ignores it.
function turnInput(signal = new AbortController().signal): HarnessTurn {
	return {
		thread: {id: 'thread-1', parentThreadId: null},
		auth: {kind: 'api_key', key: 'test-key'},
		session: null,
		entries: ENTRIES,
		subAgents: [],
		woken: false,
		system: 'You are a test.',
		tools: fakeToolSurface(TOOLS),
		model: 'claude',
		maxSteps: 1,
		signal,
	};
}

// Every event of the turn, or a failure where it took too long.
async function collect(harness: HarnessBackend, input: HarnessTurn): Promise<HarnessEvent[]> {
	const events: HarnessEvent[] = [];
	const tooLong = new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`The turn took longer than ${TURN_MS}ms`)), TURN_MS));
	await Promise.race([
		(async () => {
			for await (const event of harness.turn(input)) {
				events.push(event);
			}
		})(),
		tooLong,
	]);
	return events;
}

/** Registers the tests of the contract on the harness `make` gives, made afresh for each. */
export function harnessConformance(name: string, make: () => {harness: HarnessBackend; scripted: ScriptedModel}): void {
	describe(`${name}, as a harness`, () => {
		test('a turn ends with exactly one done or failed, the last event', async () => {
			const {harness, scripted} = make();
			scripted.answers({text: 'Looking.', toolCalls: [{id: 'c1', name: 'read', arguments: '{}'}]});

			const events = await collect(harness, turnInput());

			expect(events.filter((event) => TERMINAL.has(event.kind))).toHaveLength(1);
			expect(TERMINAL.has(events.at(-1)?.kind ?? 'text')).toBe(true);
		});

		test('a usage event, where there is one, comes before the terminal event and speaks of a window as a share with a reset', async () => {
			const {harness, scripted} = make();
			scripted.answers({text: 'Hello', toolCalls: []});

			const events = await collect(harness, turnInput());

			for (const [index, event] of events.entries()) {
				if (event.kind !== 'usage') {
					continue;
				}
				expect(index).toBeLessThan(events.length - 1);
				const windows = Object.entries(event).filter(([key]) => USAGE_WINDOWS.has(key));
				expect(windows.length).toBeGreaterThan(0);
				for (const [, window] of windows) {
					expect(window).toMatchObject({utilization: expect.any(Number)});
				}
			}
		});

		test('every call of a turn has an id of its own', async () => {
			const {harness, scripted} = make();
			scripted.answers({
				text: '',
				toolCalls: [
					{id: 'c1', name: 'read', arguments: '{"a":1}'},
					{id: 'c2', name: 'read', arguments: '{"a":2}'},
					{id: 'c3', name: 'run', arguments: '{}'},
				],
			});

			const events = await collect(harness, turnInput());
			const calls = events.filter((event) => event.kind === 'tool_call');

			expect(calls).toHaveLength(3);
			expect(new Set(calls.map((call) => call.id)).size).toBe(3);
		});

		test('a result answers a call the same turn made, and never one it didn’t', async () => {
			const {harness, scripted} = make();
			scripted.answers({text: '', toolCalls: [{id: 'c1', name: 'read', arguments: '{}'}]});

			const events = await collect(harness, turnInput());
			const made = new Set(events.filter((event) => event.kind === 'tool_call').map((call) => call.id));

			for (const result of events.filter((event) => event.kind === 'tool_result')) {
				expect(made.has(result.callId)).toBe(true);
			}
		});

		test('done carries the system prompt the model was sent, and what the turn cost', async () => {
			const {harness, scripted} = make();
			scripted.answers({text: 'Hello', toolCalls: []});

			const done = (await collect(harness, turnInput())).at(-1);

			expect(done).toMatchObject({kind: 'done', system: expect.any(String), inputTokens: expect.any(Number), outputTokens: expect.any(Number)});
		});

		test('a text event is never empty', async () => {
			const {harness, scripted} = make();
			scripted.answers({text: '', toolCalls: [{id: 'c1', name: 'read', arguments: '{}'}]});

			const events = await collect(harness, turnInput());

			expect(events.filter((event) => event.kind === 'text')).toEqual([]);
			scripted.answers({text: 'Words', toolCalls: []});
			for (const event of await collect(harness, turnInput())) {
				if (event.kind === 'text') {
					expect(event.text).not.toBe('');
				}
			}
		});

		test('a model out of reach ends the turn with failed, worth trying again', async () => {
			const {harness, scripted} = make();
			scripted.unreachable();

			const events = await collect(harness, turnInput());

			expect(events.at(-1)).toMatchObject({kind: 'failed', retry: true});
		});

		test('a turn whose signal was aborted ends, with done or failed, without hanging', async () => {
			const {harness, scripted} = make();
			scripted.answers({text: 'Hello', toolCalls: []});
			const controller = new AbortController();
			controller.abort();

			const events = await collect(harness, turnInput(controller.signal));

			expect(TERMINAL.has(events.at(-1)?.kind ?? 'text')).toBe(true);
		});
	});
}
