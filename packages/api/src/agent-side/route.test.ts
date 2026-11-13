import {beforeEach, describe, expect, mock, test} from 'bun:test';
import {Ok} from 'ts-results-es';

const requireAgent = mock();

mock.module('./tools', () => ({requireAgent}));

const pageInstructions = mock();
const runAgentScript = mock();

mock.module('../mcp/tools', () => ({pageInstructions, runAgentScript}));

const signedIn = {agentId: 'agent-1', orgId: 'org-1', ownerUserId: 'user-1', providerId: 'dot', name: 'Dots', orgSlug: 'org-1', experiments: []};

function makeRequest(body: unknown = undefined) {
	return {agent: signedIn, params: {}, body, query: {}} as never;
}

beforeEach(() => {
	mock.clearAllMocks();
	requireAgent.mockResolvedValue(Ok({id: 'agent-1', providerId: 'dot', name: 'Dots'}));
	pageInstructions.mockResolvedValue(Ok('You are Dots, signed in to Personal Agent Proxy.'));
	runAgentScript.mockResolvedValue({text: '"task-2"\n\nTask: task-2', isError: false, task: 'task-2'});
});

describe('handleAgentMeRoute', () => {
	test('says who the agent is, and what it is told', async () => {
		const {handleAgentMeRoute} = await import('./route');
		const result = await handleAgentMeRoute(makeRequest());

		expect(result.unwrap()).toEqual({agent: {id: 'agent-1', providerId: 'dot', name: 'Dots'}, instructions: 'You are Dots, signed in to Personal Agent Proxy.'});
		expect(pageInstructions).toHaveBeenCalledWith(signedIn);
	});
});

describe('handleAgentScriptRoute', () => {
	test('runs the script as the signed-in agent, over the web, for the task the page kept', async () => {
		const {handleAgentScriptRoute} = await import('./route');
		const result = await handleAgentScriptRoute(makeRequest({code: 'return await pap.connections();', task: ' task-1 '}));

		expect(result.unwrap()).toEqual({text: '"task-2"\n\nTask: task-2', isError: false, task: 'task-2'});
		expect(runAgentScript).toHaveBeenCalledWith(signedIn, 'return await pap.connections();', 'task-1', 'web');
	});

	test('a script without a task, or with an empty one, runs for none', async () => {
		const {handleAgentScriptRoute} = await import('./route');
		await handleAgentScriptRoute(makeRequest({code: 'return 1;'}));
		await handleAgentScriptRoute(makeRequest({code: 'return 1;', task: ''}));

		expect(runAgentScript.mock.calls.map((call) => call[2])).toEqual([null, null]);
	});

	test('a body that is not an object, or without code, is refused', async () => {
		const {handleAgentScriptRoute} = await import('./route');
		const nonsense = await handleAgentScriptRoute(makeRequest('nonsense'));
		const empty = await handleAgentScriptRoute(makeRequest({code: '   '}));

		expect(nonsense.unwrapErr().kind).toBe('parse_error');
		expect(empty.unwrapErr().kind).toBe('parse_error');
		expect(runAgentScript).not.toHaveBeenCalled();
	});
});
