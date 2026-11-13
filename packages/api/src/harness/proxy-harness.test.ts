import {beforeEach, describe, expect, mock, test} from 'bun:test';
import {Err, Ok} from 'ts-results-es';

import type {HarnessEntry, HarnessEvent, HarnessTurn} from '@proxy/backends/harness/backend';
import {harnessConformance, type ScriptedModel} from '@proxy/backends/harness/conformance';
import {fakeToolSurface} from '@proxy/backends/harness/fake';
import {ApiErr} from '@proxy/utils';
import {COMPACT_AT_TOKENS, type ContextEntry, EVENT_LEAD} from '@proxy/utils/harness-context';

import type {askForTurn as askForTurnOverRouter} from '../llm/open-router';
import {proxyHarness} from './proxy-harness';

// The model over OpenRouter, as the harness asks it.
const askForTurn = mock<typeof askForTurnOverRouter>();
const harness = proxyHarness({askForTurn, key: 'sk-test'});

const scripted: ScriptedModel = {
	answers: ({text, toolCalls}) => {
		askForTurn.mockResolvedValueOnce(Ok({text, toolCalls, inputTokens: 10, outputTokens: 2}));
	},
	unreachable: () => {
		askForTurn.mockResolvedValueOnce(Err(ApiErr.providerUnreachable(new Error('down'))));
	},
};

harnessConformance('the proxy harness', () => ({harness, scripted}));

let seq = 0;

function entry(kind: ContextEntry['kind'], text: string, extra: Partial<Pick<ContextEntry, 'toolCalls' | 'callId' | 'inputTokens' | 'coversSeq'>> = {}): HarnessEntry {
	seq += 1;
	return {
		kind,
		text,
		toolCalls: extra.toolCalls ?? null,
		callId: extra.callId ?? null,
		isError: false,
		seq,
		coversSeq: extra.coversSeq ?? null,
		inputTokens: extra.inputTokens ?? null,
		jobId: null,
	};
}

const read = {name: 'read', description: 'Reads', inputSchema: {type: 'object', properties: {}}, readOnly: true};

function turnInput(entries: HarnessEntry[], extra: Partial<HarnessTurn> = {}): HarnessTurn {
	return {
		thread: {id: 'thread-1'},
		job: 'job-1',
		session: null,
		entries,
		woken: false,
		system: 'You are signed in.',
		tools: fakeToolSurface([read]),
		model: 'claude',
		maxSteps: 1,
		signal: new AbortController().signal,
		...extra,
	};
}

const requests = () => askForTurn.mock.calls.map((call) => call[0]);

describe('proxyHarness', () => {
	beforeEach(() => {
		askForTurn.mockReset();
		askForTurn.mockResolvedValue(Ok({text: 'Hello', toolCalls: [], inputTokens: 10, outputTokens: 2}));
	});

	test('asks the model once, with the system prompt first, the log in the chat form and the tools, with the server’s key, and yields the words, each call and done with the cost and the session it was given', async () => {
		askForTurn.mockResolvedValue(Ok({text: 'Looking.', toolCalls: [{id: 'c2', name: 'read', arguments: '{"a":1}'}], inputTokens: 10, outputTokens: 2}));
		const log = [entry('person', 'Hi'), entry('assistant', '', {toolCalls: [{id: 'c1', name: 'read', arguments: '{}'}]}), entry('tool_result', 'rows', {callId: 'c1'})];

		const events = await Array.fromAsync(harness.turn(turnInput(log, {model: 'glm', session: {id: 's1', state: {}}})));

		expect(requests()).toEqual([
			{
				key: 'sk-test',
				model: 'glm',
				messages: [
					{role: 'system', content: 'You are signed in.'},
					{role: 'user', content: 'Hi'},
					{role: 'assistant', content: null, tool_calls: [{id: 'c1', type: 'function', function: {name: 'read', arguments: '{}'}}]},
					{role: 'tool', tool_call_id: 'c1', content: 'rows'},
				],
				tools: [{name: 'read', description: 'Reads', parameters: {type: 'object', properties: {}}}],
				maxTokens: 4000,
				timeoutMs: 120_000,
			},
		]);
		expect(events).toEqual([
			{kind: 'text', text: 'Looking.'},
			{kind: 'tool_call', id: 'c2', name: 'read', arguments: '{"a":1}'},
			{kind: 'done', session: {id: 's1', state: {}}, system: 'You are signed in.', inputTokens: 10, outputTokens: 2},
		]);
	});

	test('leads an event in as an alert that came, not the person’s', async () => {
		const log = [entry('person', 'Tell me when the invoice comes'), entry('assistant', 'I will.'), entry('event', 'The alert “Invoice from Dana” matched a new one of the emails.')];

		await Array.fromAsync(harness.turn(turnInput(log)));

		expect(requests()[0]?.messages.at(-1)).toEqual({role: 'user', content: `${EVENT_LEAD}\n\nThe alert “Invoice from Dana” matched a new one of the emails.`});
	});

	test('a log grown long is summarized first, by the same model, as text, and the summary yielded for the api to store, then read in place of what it covers', async () => {
		const log = [
			entry('person', 'One'),
			entry('assistant', '', {toolCalls: [{id: 'c1', name: 'read', arguments: '{}'}], inputTokens: 10}),
			entry('tool_result', 'rows one', {callId: 'c1'}),
			entry('assistant', 'Done one', {inputTokens: 10}),
			entry('person', 'Two'),
			entry('assistant', 'Done two', {inputTokens: 10}),
			entry('person', 'Three'),
			entry('assistant', '', {toolCalls: [{id: 'c3', name: 'read', arguments: '{}'}], inputTokens: COMPACT_AT_TOKENS}),
			entry('tool_result', 'rows three', {callId: 'c3'}),
		];
		askForTurn
			.mockResolvedValueOnce(Ok({text: 'The person asked for one; it was done.', toolCalls: [], inputTokens: 90_000, outputTokens: 300}))
			.mockResolvedValueOnce(Ok({text: 'Three is done too.', toolCalls: [], inputTokens: 2000, outputTokens: 20}));

		const events = await Array.fromAsync(harness.turn(turnInput(log, {model: 'glm'})));

		const asked = requests();
		expect(asked.map((request) => request.model)).toEqual(['glm', 'glm']);
		expect(asked[0]?.tools).toEqual([]);
		expect(asked[0]?.messages[0]).toMatchObject({role: 'system', content: expect.stringContaining('Summarize this conversation')});
		expect(asked[0]?.messages.slice(1)).toEqual([{role: 'user', content: 'Person:\nOne\n\nAgent called read with {}\n\nread answered:\nrows one\n\nAgent:\nDone one\n\nWrite the summary now.'}]);
		expect(asked[1]?.messages.slice(1).map((message) => message.content)).toEqual([expect.stringContaining('The person asked for one; it was done.'), 'Two', 'Done two', 'Three', null, 'rows three']);
		expect(events).toEqual([
			{kind: 'summary', text: 'The person asked for one; it was done.', coversSeq: log[3]?.seq ?? -1, inputTokens: 90_000, outputTokens: 300},
			{kind: 'text', text: 'Three is done too.'},
			{kind: 'done', session: null, system: 'You are signed in.', inputTokens: 2000, outputTokens: 20},
		]);
	});

	test('a model out of reach, summarizing or answering, fails the turn as worth trying again; one that refused the request, or turned the key down, as not', async () => {
		const unreachable = Err(ApiErr.providerUnreachable(new Error('down')));
		askForTurn.mockResolvedValue(unreachable);
		expect((await Array.fromAsync(harness.turn(turnInput([entry('person', 'Hi')])))).at(-1)).toEqual({kind: 'failed', error: unreachable.error, retry: true});

		const long = [
			entry('person', 'One'),
			entry('assistant', 'Done', {inputTokens: 10}),
			entry('person', 'Two'),
			entry('assistant', 'Done', {inputTokens: COMPACT_AT_TOKENS}),
			entry('person', 'Three'),
		];
		expect(await Array.fromAsync(harness.turn(turnInput(long)))).toEqual([{kind: 'failed', error: unreachable.error, retry: true}]);
		expect(askForTurn).toHaveBeenCalledTimes(2);

		const refused = Err(ApiErr.internalError(new Error('OpenRouter refused the request (400): too long')));
		askForTurn.mockResolvedValue(refused);
		expect(await Array.fromAsync(harness.turn(turnInput([entry('person', 'Hi')])))).toEqual([{kind: 'failed', error: refused.error, retry: false}]);

		const turnedDown = Err(ApiErr.unavailable('OpenRouter turned the server’s key down (401): bad key'));
		askForTurn.mockResolvedValue(turnedDown);
		expect(await Array.fromAsync(harness.turn(turnInput([entry('person', 'Hi')])))).toEqual([{kind: 'failed', error: turnedDown.error, retry: false}]);
	});

	test('an answer of no words yields no text; a model it has not got, or a turn stopped before it began, fails without asking', async () => {
		askForTurn.mockResolvedValue(Ok({text: '', toolCalls: [{id: 'c1', name: 'read', arguments: '{}'}], inputTokens: 10, outputTokens: 2}));
		const events: HarnessEvent[] = await Array.fromAsync(harness.turn(turnInput([entry('person', 'Hi')])));
		expect(events.map((event) => event.kind)).toEqual(['tool_call', 'done']);

		expect(await Array.fromAsync(harness.turn(turnInput([entry('person', 'Hi')], {model: 'gpt-oss'})))).toEqual([
			{kind: 'failed', error: ApiErr.unavailable('The proxy harness has no model gpt-oss'), retry: false},
		]);
		const controller = new AbortController();
		controller.abort();
		expect((await Array.fromAsync(harness.turn(turnInput([entry('person', 'Hi')], {signal: controller.signal})))).at(-1)).toMatchObject({kind: 'failed', retry: true});
		expect(askForTurn).toHaveBeenCalledTimes(1);
	});
});
