import {afterAll, beforeEach, describe, expect, spyOn, test} from 'bun:test';
import {z} from 'zod';

import {askForJson, askForTurn, TURN_MODEL} from './open-router';

// What OpenRouter answers, and with what status.
let status = 200;
let message: Record<string, unknown> = {content: 'Hello'};
const fetchSpy = spyOn(globalThis, 'fetch').mockImplementation((async () =>
	status === 200 ? Response.json({choices: [{message}], usage: {prompt_tokens: 120, completion_tokens: 8}}) : Response.json({error: {message: 'down'}}, {status})) as unknown as typeof fetch);

afterAll(() => {
	fetchSpy.mockRestore();
});

beforeEach(() => {
	fetchSpy.mockClear();
	status = 200;
	message = {content: 'Hello'};
});

const request = {
	key: 'sk-test',
	messages: [
		{role: 'system' as const, content: 'Be brief.'},
		{role: 'user' as const, content: 'Hi'},
	],
	tools: [{name: 'read', description: 'Reads', parameters: {type: 'object', properties: {}}}],
	maxTokens: 100,
	timeoutMs: 1000,
};

// The body of the request made to OpenRouter.
function sent(): {model: string; messages: unknown[]; tools: unknown[]; max_tokens: number; provider: {data_collection: string}} {
	return JSON.parse(String(fetchSpy.mock.calls[0]?.[1]?.body));
}

describe('askForTurn', () => {
	test('asks Claude Sonnet 5.5 over OpenRouter with the tools, on a host that keeps nothing', async () => {
		const turn = await askForTurn(request);

		expect(turn.unwrap()).toEqual({text: 'Hello', toolCalls: [], inputTokens: 120, outputTokens: 8});
		expect(String(fetchSpy.mock.calls[0]?.[0])).toBe('https://openrouter.ai/api/v1/chat/completions');
		expect((fetchSpy.mock.calls[0]?.[1]?.headers as Record<string, string>).authorization).toBe('Bearer sk-test');
		const body = sent();
		expect(body.model).toBe(TURN_MODEL);
		expect(body.messages).toEqual(request.messages);
		expect(body.tools).toEqual([{type: 'function', function: {name: 'read', description: 'Reads', parameters: {type: 'object', properties: {}}}}]);
		expect(body.max_tokens).toBe(100);
		expect(body.provider.data_collection).toBe('deny');
	});

	test('reads the calls the model made, with their arguments as it wrote them', async () => {
		message = {content: null, tool_calls: [{id: 'call-1', type: 'function', function: {name: 'read', arguments: '{"connection":"c1"}'}}]};
		const turn = await askForTurn(request);

		expect(turn.unwrap()).toEqual({text: '', toolCalls: [{id: 'call-1', name: 'read', arguments: '{"connection":"c1"}'}], inputTokens: 120, outputTokens: 8});
	});

	test('a provider that is down, or too busy, is unreachable, which is worth trying again', async () => {
		status = 502;
		expect((await askForTurn(request)).unwrapErr().kind).toBe('provider_unreachable');

		status = 429;
		expect((await askForTurn(request)).unwrapErr().kind).toBe('provider_unreachable');
	});

	test('a key turned down, or out of credit, means the server is not set up right, and says what OpenRouter said', async () => {
		status = 401;
		expect((await askForTurn(request)).unwrapErr()).toEqual({kind: 'unavailable', statusCode: 503, message: 'OpenRouter turned the server’s key down (401): down'});

		status = 402;
		expect((await askForTurn(request)).unwrapErr()).toMatchObject({kind: 'unavailable', message: expect.stringContaining('(402)')});
	});

	test('a request refused is an error of ours, which no retry mends', async () => {
		status = 400;
		const error = (await askForTurn(request)).unwrapErr();

		expect(error.kind).toBe('internal_error');
		expect(error.kind === 'internal_error' && error.cause instanceof Error ? error.cause.message : '').toBe('OpenRouter refused the request (400): down');
	});
});

describe('askForJson', () => {
	const jsonRequest = {
		key: 'sk-test',
		system: 'Answer in JSON.',
		user: 'Pricing review with Dana',
		name: 'answer',
		jsonSchema: {type: 'object', properties: {title: {type: 'string'}}},
		answer: z.object({title: z.string()}),
		maxTokens: 100,
		timeoutMs: 1000,
	};

	test('asks gpt-oss-120b on Cerebras, else Groq, only on a host that keeps nothing, and reads the JSON back', async () => {
		message = {content: '{"title":"Pricing review"}'};

		expect((await askForJson(jsonRequest)).unwrap()).toEqual({title: 'Pricing review'});
		const body = JSON.parse(String(fetchSpy.mock.calls[0]?.[1]?.body));
		expect(body.model).toBe('openai/gpt-oss-120b');
		expect(body.provider).toEqual({order: ['Cerebras', 'Groq'], allow_fallbacks: true, data_collection: 'deny', zdr: true});
		expect(body.response_format.json_schema).toEqual({name: 'answer', strict: true, schema: jsonRequest.jsonSchema});
	});

	test('an answer outside the form is a provider out of reach, and a key turned down is not set up right', async () => {
		message = {content: 'Sure! Here it is:'};
		expect((await askForJson(jsonRequest)).unwrapErr().kind).toBe('provider_unreachable');

		status = 401;
		expect((await askForJson(jsonRequest)).unwrapErr().kind).toBe('unavailable');
	});
});
