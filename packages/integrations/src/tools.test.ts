import {describe, expect, test} from 'bun:test';

import {effectiveActions} from './access';
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
			'attachments_read',
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

test('an attachment is read with the action reading email, by the email and the attachment, as the command describes it', () => {
	const read = findTool(email, 'attachments_read');

	expect(read).toMatchObject({kind: 'newCommand', action: 'read', readOnly: true});
	expect(read?.description).toStartWith('Read one of an email’s attachments as text');
	expect(Object.keys(read?.inputSchema.properties ?? {})).toEqual(['email', 'attachment']);
	expect(findTool(integration('google'), 'attachments_read')).toMatchObject({
		action: 'readEmails',
		readOnly: true,
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
		expect(findTool(notion, 'pages_update')?.inputSchema.properties?.parent).toBeUndefined();
	});

	test('a collection that is not nested takes no parent', () => {
		expect(findTool(email, 'emails_list')?.inputSchema.properties?.parent).toBeUndefined();
		expect(findTool(email, 'emails_create')?.inputSchema.properties?.parent).toBeUndefined();
	});
});

describe('linear', () => {
	const linear = integration('linear');

	test('lists, opens, creates and edits issues, but never deletes them', () => {
		expect(integrationTools(linear).map((tool) => tool.name)).toEqual([
			'issues_list',
			'issues_get',
			'issues_create',
			'issues_update',
		]);
	});

	test('a list is searched and narrowed by the type of status', () => {
		const list = findTool(linear, 'issues_list');

		expect(Object.keys(list?.inputSchema.properties ?? {})).toEqual([
			'search',
			'statusType',
			'page',
		]);
		expect(list?.inputSchema.properties?.statusType?.enum).toContain('Started');
		expect(findTool(linear, 'issues_create')?.inputSchema.properties?.statusType).toBeUndefined();
	});
});

describe('postgres and mysql', () => {
	const postgres = integration('postgres');

	test('tables are a tree of rows, and a query only ever runs', () => {
		expect(integrationTools(postgres).map((tool) => tool.name)).toEqual([
			'tables_list',
			'tables_get',
			'tables_create',
			'tables_update',
			'tables_delete',
			'queries_run',
		]);
		expect(integrationTools(integration('mysql')).map((tool) => tool.name)).toEqual(
			integrationTools(postgres).map((tool) => tool.name),
		);
	});

	test('running a query takes the SQL alone and counts as a read', () => {
		const run = findTool(postgres, 'queries_run');
		expect(run?.readOnly).toBe(true);
		expect(run?.action).toBe('query');
		expect(Object.keys(run?.inputSchema.properties ?? {})).toEqual(['sql']);
		expect(findTool(postgres, 'tables_list')?.readOnly).toBe(true);
		expect(findTool(postgres, 'tables_create')?.readOnly).toBe(false);
	});

	test('a row is written as its values, inside a table, and only rows are edited', () => {
		const create = findTool(postgres, 'tables_create');
		expect(Object.keys(create?.inputSchema.properties ?? {})).toEqual(['parent', 'values']);
		const update = findTool(postgres, 'tables_update');
		expect(update?.kind === 'update' ? update.where : null).toEqual({
			field: 'kind',
			values: ['Row'],
		});
	});
});

describe('exa and parallel', () => {
	const exa = integration('exa');

	test('searches and pages only ever run, each a read with an action of its own', () => {
		expect(integrationTools(exa).map((tool) => tool.name)).toEqual(['searches_run', 'pages_read']);
		expect(integrationTools(integration('parallel'))).toEqual(integrationTools(exa));
		expect(findTool(exa, 'searches_run')).toMatchObject({
			readOnly: true,
			action: 'search',
			risk: 'low',
		});
		expect(findTool(exa, 'pages_read')).toMatchObject({
			readOnly: true,
			action: 'fetch',
			risk: 'low',
		});
	});

	test('a search takes the query alone, and a page its address', () => {
		expect(Object.keys(findTool(exa, 'searches_run')?.inputSchema.properties ?? {})).toEqual([
			'query',
		]);
		expect(Object.keys(findTool(exa, 'pages_read')?.inputSchema.properties ?? {})).toEqual(['url']);
	});
});

describe('cloudflare', () => {
	const cloudflare = integration('cloudflare');

	test('requests only ever run, reading as a read, sending and deleting each with an action of their own', () => {
		expect(integrationTools(cloudflare).map((tool) => tool.name)).toEqual([
			'requests_read',
			'requests_send',
			'requests_remove',
			'endpoints_find',
			'docs_run',
		]);
		expect(findTool(cloudflare, 'requests_read')).toMatchObject({
			readOnly: true,
			action: 'read',
			risk: 'low',
		});
		expect(findTool(cloudflare, 'requests_send')).toMatchObject({
			readOnly: false,
			action: 'write',
			risk: 'high',
		});
		expect(findTool(cloudflare, 'requests_remove')).toMatchObject({
			readOnly: false,
			action: 'delete',
			risk: 'high',
		});
		expect(findTool(cloudflare, 'endpoints_find')).toMatchObject({readOnly: true, action: 'read'});
		expect(findTool(cloudflare, 'docs_run')).toMatchObject({readOnly: true, action: 'read'});
	});

	test('a request takes its method, path, body and account', () => {
		expect(findTool(cloudflare, 'requests_send')?.inputSchema.properties).toMatchObject({
			method: {enum: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE']},
			path: {},
			body: {},
			account: {},
		});
		expect(
			Object.keys(findTool(cloudflare, 'endpoints_find')?.inputSchema.properties ?? {}),
		).toEqual(['search']);
	});

	test('sending and deleting count only with reading', () => {
		expect(effectiveActions(cloudflare, ['write', 'delete'])).toEqual([]);
		expect(effectiveActions(cloudflare, ['read', 'delete'])).toEqual(['read', 'delete']);
	});
});

describe('google', () => {
	const google = integration('google');

	test('email has the same tools as any mailbox’s, files are never deleted, only moved to Trash, ranges and availability are only run, other contacts are only read and saved, and events, contacts and tasks are never deleted', () => {
		expect(integrationTools(google).map((tool) => tool.name)).toEqual([
			...integrationTools(email).map((tool) => tool.name),
			'events_list',
			'events_get',
			'events_create',
			'events_update',
			'events_accept',
			'events_decline',
			'events_maybe',
			'availability_check',
			'files_list',
			'files_get',
			'files_create',
			'files_update',
			'files_trash',
			'ranges_read',
			'ranges_write',
			'contacts_list',
			'contacts_get',
			'contacts_create',
			'contacts_update',
			'other_contacts_list',
			'other_contacts_get',
			'other_contacts_save',
			'tasks_list',
			'tasks_get',
			'tasks_create',
			'tasks_update',
			'tasks_complete',
			'tasks_reopen',
		]);
	});

	test('checking availability is a read with an action of its own, taking the people and the times', () => {
		const check = integrationTools(google).find((tool) => tool.name === 'availability_check');

		expect(check).toMatchObject({kind: 'newCommand', action: 'readAvailability', readOnly: true});
		expect(Object.keys(check?.inputSchema.properties ?? {})).toEqual(['people', 'from', 'to']);
	});

	test('other contacts are read with an action of their own, and saving one needs Add and edit contacts', () => {
		const tools = integrationTools(google).filter((tool) =>
			tool.name.startsWith('other_contacts_'),
		);

		expect(tools.map((tool) => [tool.name, tool.action, tool.readOnly])).toEqual([
			['other_contacts_list', 'readOtherContacts', true],
			['other_contacts_get', 'readOtherContacts', true],
			['other_contacts_save', 'writeContacts', false],
		]);
	});

	test('a task is made inside a list, narrowed by its status, and completed or reopened only where it fits', () => {
		const tools = integrationTools(google).filter((tool) => tool.name.startsWith('tasks_'));
		const named = (name: string) => tools.find((tool) => tool.name === name);

		expect(Object.keys(named('tasks_list')?.inputSchema.properties ?? {})).toEqual([
			'parent',
			'status',
			'page',
		]);
		expect(Object.keys(named('tasks_create')?.inputSchema.properties ?? {})).toEqual([
			'parent',
			'title',
			'notes',
			'due',
			'list',
		]);
		expect(named('tasks_update')).toMatchObject({
			action: 'writeTasks',
			where: {field: 'kind', values: ['Task']},
		});
		expect(named('tasks_complete')).toMatchObject({
			action: 'writeTasks',
			where: {field: 'status', values: ['Needs action']},
		});
		expect(named('tasks_reopen')).toMatchObject({
			action: 'writeTasks',
			where: {field: 'status', values: ['Done']},
		});
	});

	test('an event is made inside a calendar, its guests need Invite guests, and only events are edited', () => {
		const create = findTool(google, 'events_create');

		expect(create?.action).toBe('writeEvents');
		expect(Object.keys(create?.inputSchema.properties ?? {})).toEqual([
			'parent',
			'title',
			'start',
			'end',
			'location',
			'guests',
			'description',
		]);
		expect(create?.inputSchema.properties?.guests?.description).toContain('Invite guests');
		const update = findTool(google, 'events_update');
		expect(update?.kind === 'update' ? update.where : null).toEqual({
			field: 'kind',
			values: ['Event'],
		});
		expect(findTool(google, 'events_list')?.description).toContain('soonest first');
		expect(findTool(google, 'events_accept')).toMatchObject({
			action: 'respondEvents',
			reachesOthers: true,
			where: {field: 'response', values: ['Needs action', 'Accepted', 'Declined', 'Maybe']},
		});
	});

	test('a file is made from its kind, name and content, inside the folder given, and trashing leaves out tabs and rows', () => {
		const create = findTool(google, 'files_create');

		expect(create?.action).toBe('createFiles');
		expect(Object.keys(create?.inputSchema.properties ?? {})).toEqual([
			'parent',
			'name',
			'kind',
			'content',
		]);
		expect(findTool(google, 'files_update')).toMatchObject({action: 'editFiles', risk: 'medium'});
		const update = findTool(google, 'files_update');
		expect(update?.kind === 'update' ? update.where?.values : null).not.toContain('Place');
		expect(findTool(google, 'files_trash')).toMatchObject({
			action: 'trashFiles',
			risk: 'high',
			where: {field: 'kind', values: ['Folder', 'Document', 'Spreadsheet', 'Presentation', 'File']},
		});
	});

	test('reading a range is a read, writing one needs Edit files', () => {
		expect(findTool(google, 'ranges_read')).toMatchObject({
			action: 'readFiles',
			readOnly: true,
			kind: 'newCommand',
		});
		expect(findTool(google, 'ranges_write')).toMatchObject({action: 'editFiles', readOnly: false});
		expect(Object.keys(findTool(google, 'ranges_write')?.inputSchema.properties ?? {})).toEqual([
			'spreadsheet',
			'range',
			'values',
		]);
	});

	test('email’s tools need the Gmail actions, and a list takes its folders and Gmail’s search', () => {
		const list = findTool(google, 'emails_list');

		expect(list?.action).toBe('readEmails');
		expect(list?.inputSchema.properties?.folder?.enum).toEqual([
			'Inbox',
			'Draft',
			'Sent',
			'Archive',
			'Trash',
			'Spam',
		]);
		expect(list?.inputSchema.properties?.search?.description).toContain('Gmail');
		expect(findTool(google, 'emails_flag')).toMatchObject({
			action: 'flagEmails',
			description: expect.stringMatching(/^Star:/),
		});
		expect(findTool(google, 'emails_send_new')).toMatchObject({
			action: 'sendEmails',
			risk: 'high',
			reachesOthers: true,
		});
		expect(findTool(google, 'emails_trash')).toMatchObject({
			action: 'trashEmails',
			risk: 'high',
			where: {field: 'folder', values: ['Inbox']},
		});
		const update = findTool(google, 'emails_update');
		expect(update?.kind === 'update' ? update.where : null).toEqual({
			field: 'folder',
			values: ['Draft'],
		});
	});

	test('Gmail’s lists and opens say each email has its link in Gmail; a mailbox’s have none', () => {
		expect(findTool(google, 'emails_list')?.description).toContain(
			'and its url, its link in Gmail for the person.',
		);
		expect(findTool(google, 'emails_get')?.description).toBe(
			'Open one email by its id, with every field, and its url, its link in Gmail for the person.',
		);
		expect(findTool(email, 'emails_list')?.description).not.toContain('url');
		expect(findTool(email, 'emails_get')?.description).toBe(
			'Open one email by its id, with every field.',
		);
	});

	test('a list takes the folder to list inside and a search', () => {
		const list = findTool(google, 'files_list');

		expect(Object.keys(list?.inputSchema.properties ?? {})).toEqual(['parent', 'search', 'page']);
		expect(list?.description).toContain('hasChildren');
		expect(list?.action).toBe('readFiles');
		expect(list?.readOnly).toBe(true);
	});
});
