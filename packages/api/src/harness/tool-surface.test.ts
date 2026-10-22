import {describe, expect, test} from 'bun:test';

import {MCP_TOOLS} from '../mcp/tools';
import {isGateTool, MODEL_TOOLS} from './tool-surface';

type Params = {properties: Record<string, unknown>; required: string[]};

function tool(name: string) {
	const found = MODEL_TOOLS.find((candidate) => candidate.name === name);
	if (!found) {
		throw new Error(`No model tool ${name}`);
	}
	return {...found, parameters: found.parameters as Params};
}

describe('the built-in agent’s tools', () => {
	test('are the MCP server’s without the two about tasks, and a sleep', () => {
		expect(MODEL_TOOLS.map((candidate) => candidate.name)).toEqual(['list_connections', 'list_tools', 'read', 'run', 'send_feedback', 'sleep_until']);
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
	});
});
