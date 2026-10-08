import {describe, expect, test} from 'bun:test';

import {findIntegration, INTEGRATIONS} from './catalog';
import {allowedTools, findTool, integrationTools, toolName} from './tools';
import type {Integration} from './types';

function integration(id: string): Integration {
	const found = findIntegration(id);
	if (!found) {
		throw new Error(`No integration ${id}`);
	}
	return found;
}

const email = integration('email');

describe('integrationTools', () => {
	test('a tool per list, open, write and command, named by collection', () => {
		expect(integrationTools(email).map((tool) => tool.name)).toEqual([
			'emails_list',
			'emails_get',
			'emails_create',
			'emails_update',
			'emails_delete',
			'emails_mark_read',
			'emails_mark_unread',
			'emails_flag',
			'emails_unflag',
			'emails_archive',
			'emails_trash',
			'emails_send',
			'emails_send_new',
		]);
		expect(integrationTools(integration('granola')).map((tool) => tool.name)).toEqual([
			'notes_list',
			'notes_get',
			'transcripts_list',
			'transcripts_get',
		]);
	});

	test('names are unique within every integration', () => {
		for (const each of INTEGRATIONS) {
			const names = integrationTools(each).map((tool) => tool.name);
			expect(new Set(names).size).toBe(names.length);
		}
	});

	test('a list takes the search where there is one, the filter field and a page', () => {
		expect(findTool(email, 'emails_list')?.inputSchema).toEqual({
			type: 'object',
			properties: {
				search: {type: 'string', description: expect.stringContaining('Gmail')},
				folder: {
					type: 'string',
					description: 'Only email with this folder',
					enum: ['Inbox', 'Draft', 'Sent'],
				},
				page: {type: 'string', description: expect.any(String)},
			},
			required: [],
			additionalProperties: false,
		});
		expect(
			Object.keys(findTool(integration('granola'), 'notes_list')?.inputSchema.properties ?? {}),
		).toEqual(['page']);
	});

	test('writes take the fields that are typed in, never the ones the provider sets', () => {
		const send = findTool(email, 'emails_send_new');
		expect(Object.keys(send?.inputSchema.properties ?? {})).toEqual(['to', 'subject', 'body']);
		expect(findTool(email, 'emails_update')?.inputSchema.required).toEqual(['id']);
	});

	test('carries the action, its risk and the records it applies to', () => {
		expect(findTool(email, 'emails_send')).toMatchObject({
			kind: 'command',
			operation: 'send',
			action: 'send',
			risk: 'high',
			reachesOthers: true,
			readOnly: false,
			where: {field: 'folder', values: ['Draft']},
		});
		expect(findTool(email, 'emails_get')).toMatchObject({
			kind: 'get',
			operation: 'view',
			action: 'read',
			readOnly: true,
			reachesOthers: false,
		});
		expect(findTool(email, 'emails_archive')?.description).toBe(
			'Archive: one email, by its id. Move emails out of the inbox into the archive. Only where Folder is Inbox.',
		);
	});
});

describe('allowedTools', () => {
	test('only the tools whose action the agent has', () => {
		expect(allowedTools(email, ['send']).map((tool) => tool.name)).toEqual([
			'emails_send',
			'emails_send_new',
		]);
		expect(allowedTools(email, [])).toEqual([]);
	});
});

test('toolName turns the operation into the suffix', () => {
	expect(toolName('emails', 'view')).toBe('emails_get');
	expect(toolName('emails', 'markUnread')).toBe('emails_mark_unread');
});

describe('nested collections', () => {
	const notion = integration('notion');

	test('a list takes the record to list inside, and a new record the one it goes in', () => {
		const list = findTool(notion, 'pages_list');
		const create = findTool(notion, 'pages_create');

		expect(Object.keys(list?.inputSchema.properties ?? {})).toEqual(['parent', 'search', 'page']);
		expect(list?.description).toContain('hasChildren');
		expect(Object.keys(create?.inputSchema.properties ?? {})).toEqual([
			'parent',
			'title',
			'properties',
			'content',
		]);
		expect(findTool(notion, 'pages_update')?.inputSchema.properties.parent).toBeUndefined();
	});

	test('a collection that is not nested takes no parent', () => {
		expect(findTool(email, 'emails_list')?.inputSchema.properties.parent).toBeUndefined();
		expect(findTool(email, 'emails_create')?.inputSchema.properties.parent).toBeUndefined();
	});
});
