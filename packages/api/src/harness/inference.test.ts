import {beforeEach, describe, expect, mock, test} from 'bun:test';
import {Err, Ok} from 'ts-results-es';

import {ApiErr} from '@proxy/utils';

const mockEnv: {OPENROUTER_KEY?: string} = {};
mock.module('../utils/env', () => ({env: mockEnv}));

const getJobThread = mock();
const listEntries = mock();
const finishIdleInference = mock(async () => Ok(true));
const finishJob = mock(async () => Ok(true));
const completeInference = mock(async () => Ok(true));
const requeueJob = mock(async () => Ok(true));
mock.module('@proxy/db/harness', () => ({getJobThread, listEntries, finishIdleInference, finishJob, completeInference, requeueJob}));

const requireBuiltInAgent = mock(async () => Ok({agentId: 'agent-1', orgId: 'org-1', providerId: 'proxy', name: 'Personal Agent Proxy', experiments: []}));
mock.module('./built-in-agent', () => ({requireBuiltInAgent}));

const ensureThreadTask = mock(async () => Ok('task-1'));
mock.module('./thread-task', () => ({ensureThreadTask}));

const agentInstructions = mock(async (_agent: unknown, flow: string) => Ok(`You are signed in.\n\n${flow}`));
mock.module('../mcp/tools', () => ({agentInstructions, MCP_TOOLS: []}));

const askModel = mock();
mock.module('./model', () => ({askModel}));

mock.module('./tool-surface', () => ({MODEL_TOOLS: [{name: 'read', description: 'Reads', parameters: {}}]}));

const now = new Date('2026-10-21T10:00:00Z');
const thread = {id: 'thread-1', orgId: 'org-1', agentId: 'agent-1', taskId: 'task-1', createdAt: now};
const job = {id: 'job-1', threadId: 'thread-1', kind: 'inference' as const, status: 'running' as const, entryId: null, callId: null, runAt: now, claimedBy: 'w1', attempts: 1};

function entry(kind: 'person' | 'assistant' | 'tool_result', text: string, extra: Partial<{toolCalls: Array<{id: string; name: string; arguments: string}>; callId: string}> = {}) {
	return {id: `e-${text}`, seq: 1, threadId: 'thread-1', kind, text, toolCalls: extra.toolCalls ?? null, callId: extra.callId ?? null, isError: false, inputTokens: null, outputTokens: null, createdAt: now};
}

beforeEach(() => {
	mock.clearAllMocks();
	mockEnv.OPENROUTER_KEY = 'sk-test';
	getJobThread.mockResolvedValue(Ok(thread));
	listEntries.mockResolvedValue(Ok([entry('person', 'Hi')]));
	askModel.mockResolvedValue(Ok({text: 'Hello', toolCalls: [], inputTokens: 10, outputTokens: 2}));
});

describe('runInference', () => {
	test('runs the model on the log, as the chat form, and writes its answer with a job per call', async () => {
		const {runInference} = await import('./inference');
		listEntries.mockResolvedValue(
			Ok([
				entry('person', 'Hi'),
				entry('assistant', '', {toolCalls: [{id: 'c1', name: 'read', arguments: '{}'}]}),
				entry('tool_result', '{"records":[]}', {callId: 'c1'}),
			]),
		);
		askModel.mockResolvedValue(Ok({text: '', toolCalls: [{id: 'c2', name: 'sleep_until', arguments: '{"seconds":60}'}, {id: 'c3', name: 'read', arguments: '{}'}], inputTokens: 10, outputTokens: 2}));

		const result = await runInference(job, 'w1', now);

		expect(result.isOk()).toBe(true);
		expect(ensureThreadTask).toHaveBeenCalledWith(thread, now);
		const request = askModel.mock.calls[0]?.[0] as {messages: Array<Record<string, unknown>>; tools: unknown[]};
		expect(request.messages[0]).toMatchObject({role: 'system'});
		expect(String(request.messages[0]?.content)).toContain('You are talking with the person directly');
		expect(String(request.messages[0]?.content)).toContain('The time now is 2026-10-21T10:00:00.000Z');
		expect(request.messages.slice(1)).toEqual([
			{role: 'user', content: 'Hi'},
			{role: 'assistant', content: null, tool_calls: [{id: 'c1', type: 'function', function: {name: 'read', arguments: '{}'}}]},
			{role: 'tool', tool_call_id: 'c1', content: '{"records":[]}'},
		]);
		expect(request.tools).toEqual([{name: 'read', description: 'Reads', parameters: {}}]);
		expect(completeInference).toHaveBeenCalledWith(
			'job-1',
			'w1',
			'thread-1',
			{text: '', toolCalls: [{id: 'c2', name: 'sleep_until', arguments: '{"seconds":60}'}, {id: 'c3', name: 'read', arguments: '{}'}], inputTokens: 10, outputTokens: 2},
			{c2: new Date('2026-10-21T10:01:00Z')},
		);
	});

	test('a log with a call still running is left alone, and a thread that is gone ends the job', async () => {
		const {runInference} = await import('./inference');
		listEntries.mockResolvedValue(Ok([entry('person', 'Hi'), entry('assistant', '', {toolCalls: [{id: 'c1', name: 'read', arguments: '{}'}]})]));
		await runInference(job, 'w1', now);
		expect(finishIdleInference).toHaveBeenCalledWith('job-1', 'w1', 'thread-1');
		expect(askModel).not.toHaveBeenCalled();

		getJobThread.mockResolvedValue(Ok(null));
		await runInference(job, 'w1', now);
		expect(finishJob).toHaveBeenCalledWith('job-1', 'w1');
	});

	test('without a key, the person is told the server is not set up', async () => {
		const {runInference} = await import('./inference');
		delete mockEnv.OPENROUTER_KEY;

		await runInference(job, 'w1', now);

		expect(askModel).not.toHaveBeenCalled();
		expect(completeInference).toHaveBeenCalledWith('job-1', 'w1', 'thread-1', expect.objectContaining({text: expect.stringContaining('OPENROUTER_KEY'), toolCalls: []}), {});
	});

	test('a model that can’t be reached is tried again later, and the person told after the last try', async () => {
		const {runInference} = await import('./inference');
		askModel.mockResolvedValue(Err(ApiErr.providerUnreachable(new Error('down'))));

		await runInference(job, 'w1', now);
		expect(requeueJob).toHaveBeenCalledWith('job-1', 'w1', new Date('2026-10-21T10:00:05Z'));
		expect(completeInference).not.toHaveBeenCalled();

		await runInference({...job, attempts: 3}, 'w1', now);
		expect(completeInference).toHaveBeenCalledWith('job-1', 'w1', 'thread-1', expect.objectContaining({text: expect.stringContaining('could not be reached')}), {});
	});

	test('after thirty answers without the person, it stops and says so', async () => {
		const {runInference} = await import('./inference');
		const alone = [entry('person', 'Go'), ...Array.from({length: 30}, (_, i) => entry('assistant', `step ${i}`))];
		listEntries.mockResolvedValue(Ok([...alone, entry('tool_result', 'x', {callId: 'none'})]));

		await runInference(job, 'w1', now);

		expect(askModel).not.toHaveBeenCalled();
		expect(completeInference).toHaveBeenCalledWith('job-1', 'w1', 'thread-1', expect.objectContaining({text: expect.stringContaining('30 steps')}), {});
	});
});
