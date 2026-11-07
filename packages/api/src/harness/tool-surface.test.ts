import {describe, expect, mock, test} from 'bun:test';

// The catalog's modules read the api's env as they load, and ci has no .env: so the env is mocked,
// and the modules imported after, since a static import would load before the mock.
mock.module('../utils/env', () => ({env: {NODE_ENV: 'test', APP_URL: 'http://localhost:5173'}}));
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
	test('are four: starting a sub-agent, with a title and a brief, sending one a message, by id, setting an alert and cancelling one', () => {
		expect(MAIN_AGENT_TOOLS.map((candidate) => candidate.name)).toEqual(['create_subagent', 'send_to_subagent', 'set_alert', 'cancel_alert']);
		expect((MAIN_AGENT_TOOLS[0]?.parameters as Params).required).toEqual(['title', 'brief']);
		expect((MAIN_AGENT_TOOLS[1]?.parameters as Params).required).toEqual(['subagent', 'text']);
		expect((MAIN_AGENT_TOOLS[2]?.parameters as Params).required).toEqual(['title', 'brief']);
		expect((MAIN_AGENT_TOOLS[3]?.parameters as Params).required).toEqual(['id']);
	});

	test('are the conversation’s, and a sub-agent gets its own', () => {
		expect(toolsFor({parentThreadId: null})).toBe(MAIN_AGENT_TOOLS);
		expect(toolsFor({parentThreadId: 'thread-1'})).toBe(SUB_AGENT_TOOLS);
	});
});

describe('a sub-agent’s tools', () => {
	test('are the MCP server’s script, a message to the agent it works for, and a sleep', () => {
		expect(SUB_AGENT_TOOLS.map((candidate) => candidate.name)).toEqual(['script', 'send_to_parent', 'sleep_until']);
		expect(tool('send_to_parent').parameters.required).toEqual(['text']);
	});

	test('the script takes no task, and starts and finishes none: the loop keeps its task', () => {
		expect(tool('script').parameters.properties).not.toHaveProperty('task');
		expect(tool('script').parameters.required).toEqual(['code']);
		expect(tool('script').description).toContain('pap.call(connection, tool, params?)');
		expect(tool('script').description).toContain('Every call is made for your task, kept for you.');
		expect(tool('script').description).not.toContain('pap.startTask');
		expect(tool('script').description).not.toContain('pap.finishTask');
	});

	test('the gate’s one tool is the script', () => {
		expect(isGateTool('script')).toBe(true);
		expect(isGateTool('read')).toBe(false);
		expect(isGateTool('sleep_until')).toBe(false);
		expect(isGateTool('send_to_parent')).toBe(false);
		expect(isGateTool('create_subagent')).toBe(false);
	});
});
