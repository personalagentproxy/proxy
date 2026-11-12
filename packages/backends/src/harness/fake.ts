import {Ok} from 'ts-results-es';

import type {HarnessBackend, HarnessEvent, HarnessTurn, ToolAnswer, ToolSurface} from './backend';

/**
 * A harness for the tests of what runs one: it yields the events it was told to, in order, and
 * keeps every turn it was asked for, so a test can say what the harness does and read what it was
 * given. A turn it was told nothing for ends at once with `done` and no session. The tool surface
 * here records every call and answers each with a canned result, for the conformance tests and for
 * a harness under test that runs tools itself.
 */

export type FakeHarness = HarnessBackend & {
	/** Every turn asked for so far, in order. */
	turns: HarnessTurn[];
	/** What the next turn asked for yields, one list per turn, in order. */
	script: (events: HarnessEvent[]) => void;
};

export function fakeHarness(id = 'fake'): FakeHarness {
	const scripted: HarnessEvent[][] = [];
	const turns: HarnessTurn[] = [];
	return {
		id,
		label: 'Fake',
		models: [
			{id: 'claude', label: 'Claude'},
			{id: 'other', label: 'Other'},
		],
		turns,
		script: (events) => {
			scripted.push(events);
		},
		turn: async function* (input) {
			turns.push(input);
			const events = scripted.shift() ?? [{kind: 'done', session: null, inputTokens: 0, outputTokens: 0}];
			for (const event of events) {
				yield event;
			}
		},
	};
}

export type FakeToolSurface = ToolSurface & {
	/** Every call `execute` was given, in order. */
	calls: Array<{id: string; name: string; arguments: string}>;
};

/** A surface of `tools`, each call to which is recorded and answered with `answer`, the same for every call. */
export function fakeToolSurface(tools: ToolSurface['tools'], answer: ToolAnswer = {text: 'ok', isError: false}): FakeToolSurface {
	const calls: FakeToolSurface['calls'] = [];
	return {
		tools,
		calls,
		execute: async (call) => {
			calls.push(call);
			return Ok(answer);
		},
	};
}
