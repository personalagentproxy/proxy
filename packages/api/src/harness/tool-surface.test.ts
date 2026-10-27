import {describe, expect, mock, test} from 'bun:test';

// The catalog's modules read the api's env as they load, and ci has no .env: so the env is mocked,
// and the modules imported after, since a static import would load before the mock.
mock.module('../utils/env', () => ({env: {NODE_ENV: 'test', APP_URL: 'http://localhost:5173'}}));
const {MCP_TOOLS} = await import('../mcp/tools');
const {isGateTool, MAIN_AGENT_TOOLS, SUB_AGENT_TOOLS, toolsFor} = await import('./tool-surface');

type Params = {properties: Record<string, unknown>; required: string[]};

function tool(name: string) {
	const found = SUB_AGENT_TOOLS.find((candidate) => candidate.name === name);
	if (!found) {
		throw new Error(`No sub-agent tool ${name}`);
	}
	return {...found, parameters: found.parameters as Params};
}

describe('the main agent’s tools', () => {
	test('are one: delegating, with a title and a brief', () => {
		expect(MAIN_AGENT_TOOLS.map((candidate) => candidate.name)).toEqual(['delegate']);
		expect((MAIN_AGENT_TOOLS[0]?.parameters as Params).required).toEqual(['title', 'brief']);
	});

	test('are the conversation’s, and a sub-agent gets its own', () => {
		expect(toolsFor({parentThreadId: null})).toBe(MAIN_AGENT_TOOLS);
		expect(toolsFor({parentThreadId: 'thread-1'})).toBe(SUB_AGENT_TOOLS);
	});
});

describe('a sub-agent’s tools', () => {
	test('are the MCP server’s without the two about tasks, and a sleep', () => {
		expect(SUB_AGENT_TOOLS.map((candidate) => candidate.name)).toEqual(['list_connections', 'list_tools', 'read', 'run', 'send_feedback', 'sleep_until']);
	});

	test('take no task: the loop fills it in', () => {
		for (const name of ['list_connections', 'list_tools', 'read', 'run']) {
			expect(tool(name).parameters.properties).not.toHaveProperty('task');
			expect(tool(name).parameters.required).not.toContain('task');
			expect(tool(name).description).not.toContain('from start_task');
		}
		expect(tool('read').parameters.required).toEqual(['connection', 'tool']);
	});

	test('keep every other param the MCP server’s have', () => {
		const run = MCP_TOOLS.find((candidate) => candidate.name === 'run');
		expect(Object.keys(tool('run').parameters.properties)).toEqual(Object.keys(run?.inputSchema.properties ?? {}).filter((key) => key !== 'task'));
	});

	test('the gate’s tools are the MCP server’s but the task ones', () => {
		expect(isGateTool('read')).toBe(true);
		expect(isGateTool('send_feedback')).toBe(true);
		expect(isGateTool('start_task')).toBe(false);
		expect(isGateTool('sleep_until')).toBe(false);
		expect(isGateTool('delegate')).toBe(false);
	});
});
