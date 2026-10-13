import {beforeEach, describe, expect, mock, test} from 'bun:test';
import {Ok} from 'ts-results-es';

const runAgentTool = mock();
const listAgentTools = mock();
const listAgentConnections = mock();

mock.module('./tools', () => ({runAgentTool, listAgentTools, listAgentConnections}));

const signedIn = {agentId: 'agent-1', orgId: 'org-1', providerId: 'dot', name: 'Dots'};

function makeRequest(params: Record<string, string>, body: unknown = undefined, headers: Record<string, string> = {}) {
	return {agent: signedIn, params, body, query: {}, headers} as never;
}

beforeEach(() => {
	mock.clearAllMocks();
	runAgentTool.mockResolvedValue(Ok({record: null}));
	listAgentTools.mockResolvedValue(Ok([]));
});

describe('handleAgentRunToolRoute', () => {
	test("runs the URL's tool with the body's params, as the signed-in agent", async () => {
		const {handleAgentRunToolRoute} = await import('./route');
		const result = await handleAgentRunToolRoute(makeRequest({connectionId: 'mail-1', toolName: 'emails_archive'}, {params: {id: 'inbox-7-12'}}));

		expect(result.unwrap()).toEqual({record: null});
		expect(runAgentTool).toHaveBeenCalledWith({agent: signedIn, via: 'web'}, 'mail-1', 'emails_archive', {id: 'inbox-7-12'});
	});

	test('a body without params runs the tool with none', async () => {
		const {handleAgentRunToolRoute} = await import('./route');
		await handleAgentRunToolRoute(makeRequest({connectionId: 'mail-1', toolName: 'emails_list'}));

		expect(runAgentTool).toHaveBeenCalledWith({agent: signedIn, via: 'web'}, 'mail-1', 'emails_list', undefined);
	});

	test('a run from the proxy command line is marked as one, for the activity log alone', async () => {
		const {handleAgentRunToolRoute} = await import('./route');
		await handleAgentRunToolRoute(makeRequest({connectionId: 'tt-1', toolName: 'tasks_list'}, {params: {}}, {'x-proxy-client': 'cli'}));
		await handleAgentRunToolRoute(makeRequest({connectionId: 'tt-1', toolName: 'tasks_list'}, {params: {}}, {'x-proxy-client': 'mcp'}));

		expect(runAgentTool.mock.calls.map((call) => call[0])).toEqual([
			{agent: signedIn, via: 'cli'},
			{agent: signedIn, via: 'web'},
		]);
	});

	test('a body that is not an object is refused', async () => {
		const {handleAgentRunToolRoute} = await import('./route');
		const result = await handleAgentRunToolRoute(makeRequest({connectionId: 'mail-1', toolName: 'emails_list'}, 'nonsense'));

		expect(result.unwrapErr().kind).toBe('parse_error');
		expect(runAgentTool).not.toHaveBeenCalled();
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
