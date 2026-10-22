import {afterAll, beforeEach, describe, expect, spyOn, test} from 'bun:test';

import {askModel, MODEL} from './model';

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

describe('askModel', () => {
	test('asks Claude Sonnet 5.5 over OpenRouter with the tools, on a host that keeps nothing', async () => {
		const turn = await askModel(request);

		expect(turn.unwrap()).toEqual({text: 'Hello', toolCalls: [], inputTokens: 120, outputTokens: 8});
		expect(String(fetchSpy.mock.calls[0]?.[0])).toBe('https://openrouter.ai/api/v1/chat/completions');
		expect((fetchSpy.mock.calls[0]?.[1]?.headers as Record<string, string>).authorization).toBe('Bearer sk-test');
		const body = sent();
		expect(body.model).toBe(MODEL);
		expect(body.messages).toEqual(request.messages);
		expect(body.tools).toEqual([{type: 'function', function: {name: 'read', description: 'Reads', parameters: {type: 'object', properties: {}}}}]);
		expect(body.max_tokens).toBe(100);
		expect(body.provider.data_collection).toBe('deny');
	});

	test('reads the calls the model made, with their arguments as it wrote them', async () => {
		message = {content: null, tool_calls: [{id: 'call-1', type: 'function', function: {name: 'read', arguments: '{"connection":"c1"}'}}]};
		const turn = await askModel(request);

		expect(turn.unwrap()).toEqual({text: '', toolCalls: [{id: 'call-1', name: 'read', arguments: '{"connection":"c1"}'}], inputTokens: 120, outputTokens: 8});
	});

	test('a provider that answers with an error is unreachable', async () => {
		status = 502;
		const turn = await askModel(request);

		expect(turn.unwrapErr().kind).toBe('provider_unreachable');
	});
});
