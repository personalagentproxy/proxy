import {describe, expect, test} from 'bun:test';

import {integrationFor, mcpToolActions, mcpToolRisk, type McpTool} from './mcp-tools';
import {integrationTools} from './tools';

const search: McpTool = {
	name: 'search_docs',
	title: 'Search docs',
	description: 'Searches the docs.\n\nReturns the best matches.',
	inputSchema: {
		type: 'object',
		properties: {query: {type: 'string', description: 'What to look for'}},
		required: ['query'],
	},
	annotations: {readOnlyHint: true},
};

const publish: McpTool = {
	name: 'publish_doc',
	description: 'Publishes a doc to the site.',
	inputSchema: {type: 'object', properties: {id: {type: 'string'}}},
	annotations: {readOnlyHint: false, destructiveHint: false, openWorldHint: true},
};

const wipe: McpTool = {
	name: 'delete_doc',
	inputSchema: {type: 'object'},
	annotations: {destructiveHint: true},
};

const mystery: McpTool = {name: 'do_thing', inputSchema: {type: 'object'}};

describe('mcpToolRisk', () => {
	test('reads are low, changes that can be undone medium, ones that cannot high, and a tool that says nothing unknown', () => {
		expect(mcpToolRisk(search)).toBe('low');
		expect(mcpToolRisk(publish)).toBe('medium');
		expect(mcpToolRisk(wipe)).toBe('high');
		expect(mcpToolRisk(mystery)).toBe('unknown');
		expect(mcpToolRisk({...mystery, annotations: {readOnlyHint: false}})).toBe('unknown');
	});
});

describe('mcpToolActions', () => {
	test('one action per tool, named by the tool, the first line of its description beside it, high-risk ones last', () => {
		expect(mcpToolActions([wipe, mystery, publish, search])).toEqual([
			{id: 'search_docs', label: 'Search docs', description: 'Searches the docs.', risk: 'low'},
			{
				id: 'publish_doc',
				label: 'publish_doc',
				description: 'Publishes a doc to the site.',
				risk: 'medium',
				reachesOthers: true,
			},
			{id: 'do_thing', label: 'do_thing', description: '', risk: 'unknown'},
			{id: 'delete_doc', label: 'delete_doc', description: '', risk: 'high'},
		]);
	});
});

describe('integrationFor', () => {
	test("a custom MCP connection's integration has its own tools as actions and tools, the rest the catalog's", () => {
		const integration = integrationFor({integrationId: 'mcp', tools: [search, publish]});
		expect(integration?.name).toBe('Custom MCP server');
		expect(integration?.actions.map((action) => action.id)).toEqual(['search_docs', 'publish_doc']);
		expect(
			integrationTools(
				integration ?? {id: 'mcp', name: '', description: '', actions: [], collections: []},
			),
		).toEqual([
			{
				name: 'search_docs',
				title: 'Search docs',
				description: 'Searches the docs.\n\nReturns the best matches.',
				kind: 'call',
				operation: 'search_docs',
				action: 'search_docs',
				readOnly: true,
				risk: 'low',
				reachesOthers: false,
				inputSchema: search.inputSchema,
			},
			{
				name: 'publish_doc',
				title: 'publish_doc',
				description: 'Publishes a doc to the site.',
				kind: 'call',
				operation: 'publish_doc',
				action: 'publish_doc',
				readOnly: false,
				risk: 'medium',
				reachesOthers: true,
				inputSchema: publish.inputSchema,
			},
		]);
		expect(integrationFor({integrationId: 'email', tools: null})?.actions.length).toBeGreaterThan(
			0,
		);
		expect(integrationFor({integrationId: 'gone'})).toBeUndefined();
	});
});
