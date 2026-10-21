import {beforeEach, describe, expect, mock, test} from 'bun:test';
import {Ok} from 'ts-results-es';

const runAgentTool = mock();
const listAgentTools = mock();
const listAgentConnections = mock();

mock.module('./tools', () => ({runAgentTool, listAgentTools, listAgentConnections}));

const sendAgentFeedback = mock();

mock.module('./feedback', () => ({sendAgentFeedback}));

const startAgentTask = mock();
const finishAgentTask = mock();
const listAgentOpenTasks = mock();
const getAgentOpenTask = mock();

mock.module('./tasks', () => ({startAgentTask, finishAgentTask, listAgentOpenTasks, getAgentOpenTask}));

const signedIn = {agentId: 'agent-1', orgId: 'org-1', ownerUserId: 'user-1', providerId: 'dot', name: 'Dots', experiments: []};

function makeRequest(params: Record<string, string>, body: unknown = undefined) {
	return {agent: signedIn, params, body, query: {}} as never;
}

beforeEach(() => {
	mock.clearAllMocks();
	runAgentTool.mockResolvedValue(Ok({record: null}));
	listAgentTools.mockResolvedValue(Ok([]));
});

describe('handleAgentRunToolRoute', () => {
	test("runs the URL's tool with the body's params, as the signed-in agent, for the body's task", async () => {
		const {handleAgentRunToolRoute} = await import('./route');
		const result = await handleAgentRunToolRoute(makeRequest({connectionId: 'mail-1', toolName: 'emails_archive'}, {task: 'task-1', params: {id: 'inbox-7-12'}}));

		expect(result.unwrap()).toEqual({record: null});
		expect(runAgentTool).toHaveBeenCalledWith({agent: signedIn, via: 'web', taskId: 'task-1'}, 'mail-1', 'emails_archive', {id: 'inbox-7-12'});
	});

	test('a body without params runs the tool with none', async () => {
		const {handleAgentRunToolRoute} = await import('./route');
		await handleAgentRunToolRoute(makeRequest({connectionId: 'mail-1', toolName: 'emails_list'}, {task: 'task-1'}));

		expect(runAgentTool).toHaveBeenCalledWith({agent: signedIn, via: 'web', taskId: 'task-1'}, 'mail-1', 'emails_list', undefined);
	});

	test('a body that is not an object, or without a task, is refused', async () => {
		const {handleAgentRunToolRoute} = await import('./route');
		const nonsense = await handleAgentRunToolRoute(makeRequest({connectionId: 'mail-1', toolName: 'emails_list'}, 'nonsense'));
		const taskless = await handleAgentRunToolRoute(makeRequest({connectionId: 'mail-1', toolName: 'emails_list'}, {params: {}}));

		expect(nonsense.unwrapErr().kind).toBe('parse_error');
		expect(taskless.unwrapErr().kind).toBe('parse_error');
		expect(runAgentTool).not.toHaveBeenCalled();
	});
});

describe('handleAgentStartTaskRoute and handleAgentFinishTaskRoute', () => {
	test('start and finish the task as the signed-in agent, over the web', async () => {
		const started = {task: 'task-1', title: 'Triage inbox', goal: 'Archive the newsletters', startedAt: '2026-10-16T09:00:00.000Z', finishedAt: null};
		startAgentTask.mockResolvedValue(Ok(started));
		finishAgentTask.mockResolvedValue(Ok({...started, finishedAt: '2026-10-16T09:30:00.000Z'}));
		const {handleAgentFinishTaskRoute, handleAgentStartTaskRoute} = await import('./route');
		const start = await handleAgentStartTaskRoute(makeRequest({}, {title: 'Triage inbox', goal: 'Archive the newsletters'}));
		const finish = await handleAgentFinishTaskRoute(makeRequest({taskId: 'task-1'}));

		expect(start.unwrap()).toEqual(started);
		expect(startAgentTask).toHaveBeenCalledWith({agent: signedIn, via: 'web'}, {title: 'Triage inbox', goal: 'Archive the newsletters'});
		expect(finish.unwrap().finishedAt).toBe('2026-10-16T09:30:00.000Z');
		expect(finishAgentTask).toHaveBeenCalledWith({agent: signedIn, via: 'web'}, {task: 'task-1'});
	});
});

describe('handleAgentListTasksRoute', () => {
	test('lists the signed-in agent’s tasks under way', async () => {
		listAgentOpenTasks.mockResolvedValue(Ok({tasks: []}));
		const {handleAgentListTasksRoute} = await import('./route');
		const result = await handleAgentListTasksRoute(makeRequest({}));

		expect(result.unwrap()).toEqual({tasks: []});
		expect(listAgentOpenTasks).toHaveBeenCalledWith(signedIn);
	});
});

describe('handleAgentGetTaskRoute', () => {
	test('opens the URL’s task for the signed-in agent', async () => {
		const task = {task: 'task-1', title: 'Triage inbox', goal: 'Archive the newsletters', startedAt: '2026-10-16T09:00:00.000Z', finishedAt: null};
		getAgentOpenTask.mockResolvedValue(Ok(task));
		const {handleAgentGetTaskRoute} = await import('./route');
		const result = await handleAgentGetTaskRoute(makeRequest({taskId: 'task-1'}));

		expect(result.unwrap()).toEqual(task);
		expect(getAgentOpenTask).toHaveBeenCalledWith(signedIn, 'task-1');
	});
});

describe('handleAgentListToolsRoute', () => {
	test("lists the connection's tools for the signed-in agent", async () => {
		const {handleAgentListToolsRoute} = await import('./route');
		const result = await handleAgentListToolsRoute(makeRequest({connectionId: 'mail-1'}));

		expect(result.unwrap()).toEqual({tools: []});
		expect(listAgentTools).toHaveBeenCalledWith(signedIn, 'mail-1');
	});
});

describe('handleAgentFeedbackRoute', () => {
	test('sends the body as feedback from the signed-in agent, over the web', async () => {
		sendAgentFeedback.mockResolvedValue(Ok({sent: true}));
		const {handleAgentFeedbackRoute} = await import('./route');
		const result = await handleAgentFeedbackRoute(makeRequest({}, {message: 'Save did nothing'}));

		expect(result.unwrap()).toEqual({sent: true});
		expect(sendAgentFeedback).toHaveBeenCalledWith({agent: signedIn, via: 'web'}, {message: 'Save did nothing'});
	});
});
