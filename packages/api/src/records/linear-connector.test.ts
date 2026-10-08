import {beforeEach, describe, expect, mock, test} from 'bun:test';
import {Err, Ok, type Result} from 'ts-results-es';

import {ApiErr, type ApiError} from '@proxy/utils';
import {findCollection, findIntegration, type Collection} from '@proxy/integrations';

// Linear's tools by name, answering as its MCP server does.
type Call = {name: string; args: Record<string, unknown>};
const tools = {calls: [] as Call[], answer: (_call: Call): Result<string, ApiError> => Ok('')};

mock.module('../connections/mcp/mcp-session', () => ({
	callMcpToolFor: async (_server: unknown, _connection: unknown, name: string, args: Record<string, unknown>) => {
		tools.calls.push({name, args});
		return tools.answer({name, args});
	},
}));

function issues(): Collection {
	const integration = findIntegration('linear');
	const found = integration && findCollection(integration, 'issues');
	if (!found) {
		throw new Error('No issues collection');
	}
	return found;
}

const target = {
	connection: {id: 'linear-1', integrationId: 'linear', account: 'alex@example.com · Acme', createdAt: new Date(), defaults: [], credential: 'v1.encrypted'},
	collection: issues(),
};

const query = (changes: object = {}) => ({search: null, page: null, filter: null, parent: null, ...changes});
const CURSOR = '7c8fec34-211d-4973-b539-3af08917e3d1';

const ISSUE = {
	id: 'ENG-5',
	title: 'Fix the login page',
	team: 'Engineering',
	status: 'In Progress',
	statusType: 'started',
	assignee: 'Sam Lee',
	updatedAt: '2026-10-08T08:16:23.137Z',
	priority: {value: 2, name: 'High'},
	project: null,
	labels: ['Bug', 'Frontend'],
	dueDate: null,
	createdBy: 'Alex Kim',
	url: 'https://linear.app/acme/issue/ENG-5/fix-the-login-page',
	description: 'The **button** is gone',
};

const COMMENTS = {
	comments: [
		{id: 'c2', body: 'On it', createdAt: '2026-10-08T09:30:00.000Z', parentId: 'c1', quotedText: null, author: {name: 'Sam Lee'}, onBehalfOf: null},
		{id: 'c1', body: 'Can you look?', createdAt: '2026-10-08T09:00:00.000Z', parentId: null, quotedText: null, author: {name: 'Alex Kim'}, onBehalfOf: null},
	],
	hasNextPage: false,
};

// The values the agent side hands an edit: the issue as it is, then what the agent wrote.
const CURRENT = {
	title: 'Fix the login page',
	team: 'Engineering',
	status: 'In Progress',
	priority: 'High',
	assignee: 'Sam Lee',
	project: '',
	labels: 'Bug, Frontend',
	dueDate: '',
	description: 'The **button** is gone',
};

// A workspace of one issue, ENG-5, which a save moves to ENG-6 when it changes the team.
function answer({name, args}: Call): Result<string, ApiError> {
	if (name === 'get_issue' && (args.id === 'ENG-5' || args.id === 'ENG-6')) {
		return Ok(JSON.stringify({...ISSUE, id: args.id}));
	}
	if (name === 'get_issue') {
		return Err(ApiErr.notFound('issue'));
	}
	if (name === 'list_comments') {
		return Ok(JSON.stringify(COMMENTS));
	}
	if (name === 'save_issue') {
		return Ok(JSON.stringify({...ISSUE, id: args.team === 'Design' ? 'ENG-6' : 'ENG-5'}));
	}
	return Ok(JSON.stringify({issues: [ISSUE], hasNextPage: true, cursor: CURSOR}));
}

beforeEach(() => {
	tools.calls = [];
	tools.answer = answer;
});

describe('linearConnector.list', () => {
	test('the issues updated last first, 50 to a page from the cursor given, with the next one', async () => {
		const {linearConnector} = await import('./linear-connector');
		const page = (await linearConnector.list(target, query({page: CURSOR}))).unwrap();

		expect(tools.calls).toEqual([{name: 'list_issues', args: {limit: 50, orderBy: 'updatedAt', fields: ['id', 'title', 'team', 'status', 'statusType', 'assignee', 'updatedAt'], cursor: CURSOR}}]);
		expect(page).toEqual({
			records: [
				{
					id: 'ENG-5',
					values: {title: 'Fix the login page', team: 'Engineering', status: 'In Progress', statusType: 'Started', assignee: 'Sam Lee', updated: '2026-10-08T08:16:23.137Z'},
					updatedAt: '2026-10-08T08:16:23.137Z',
				},
			],
			nextPage: CURSOR,
		});
	});

	test('searches titles and descriptions and narrows to a type of status', async () => {
		const {linearConnector} = await import('./linear-connector');
		await linearConnector.list(target, query({search: 'login', filter: 'Started'}));

		expect(tools.calls[0]?.args).toMatchObject({query: 'login', state: 'started'});
	});

	test('a page token that is not a cursor is refused before asking Linear', async () => {
		const {linearConnector} = await import('./linear-connector');

		expect((await linearConnector.list(target, query({page: 'next'}))).unwrapErr().kind).toBe('validation_error');
		expect(tools.calls).toEqual([]);
	});
});

describe('linearConnector.get', () => {
	test('opens an issue by its identifier, in any case, with its comments oldest first', async () => {
		const {linearConnector} = await import('./linear-connector');
		const record = (await linearConnector.get(target, 'eng-5')).unwrap();

		expect(tools.calls.map((call) => call.name)).toEqual(['get_issue', 'list_comments']);
		expect(tools.calls[0]?.args).toMatchObject({id: 'ENG-5'});
		expect(tools.calls[1]?.args).toEqual({issueId: 'ENG-5', orderBy: 'createdAt', limit: 250});
		expect(record.values).toEqual({
			title: 'Fix the login page',
			team: 'Engineering',
			status: 'In Progress',
			statusType: 'Started',
			assignee: 'Sam Lee',
			updated: '2026-10-08T08:16:23.137Z',
			priority: 'High',
			project: '',
			labels: 'Bug, Frontend',
			dueDate: '',
			createdBy: 'Alex Kim',
			link: 'https://linear.app/acme/issue/ENG-5/fix-the-login-page',
			description: 'The **button** is gone',
			comments: 'Alex Kim · 2026-10-08 09:00 UTC\nCan you look?\n\n---\n\nReply from Sam Lee · 2026-10-08 09:30 UTC\nOn it',
		});
	});

	test('an issue Linear has no such one of, or an id that is not an identifier, is not found', async () => {
		const {linearConnector} = await import('./linear-connector');

		expect((await linearConnector.get(target, 'ENG-999')).unwrapErr()).toEqual(ApiErr.notFound('record', 'ENG-999'));
		expect((await linearConnector.get(target, 'me')).unwrapErr()).toEqual(ApiErr.notFound('record', 'me'));
		expect(tools.calls.map((call) => call.args.id)).toEqual(['ENG-999']);
	});
});

describe('linearConnector.create', () => {
	test('sends the fields written, by name, and leaves the empty ones to the team', async () => {
		const {linearConnector} = await import('./linear-connector');
		const values = {title: 'New issue', team: 'ENG', status: '', priority: 'Urgent', assignee: 'me', project: '', labels: 'Bug, , Frontend', dueDate: '2026-10-20', description: ''};
		const record = (await linearConnector.create(target, values, null)).unwrap();

		expect(tools.calls[0]).toEqual({name: 'save_issue', args: {title: 'New issue', team: 'ENG', priority: 1, assignee: 'me', labels: ['Bug', 'Frontend'], dueDate: '2026-10-20'}});
		expect(record.id).toBe('ENG-5');
	});

	test('an issue needs a team, before asking Linear', async () => {
		const {linearConnector} = await import('./linear-connector');
		const created = await linearConnector.create(target, {title: 'New issue', team: ''}, null);

		expect(created.unwrapErr()).toEqual(ApiErr.validationError('An issue needs a team'));
		expect(tools.calls).toEqual([]);
	});
});

describe('linearConnector.update', () => {
	test('sends only the fields written differently, an empty one clearing it', async () => {
		const {linearConnector} = await import('./linear-connector');
		await linearConnector.update(target, 'ENG-5', {...CURRENT, labels: 'Frontend,Bug', assignee: '', priority: 'No priority', status: 'Done'});

		const save = tools.calls.find((call) => call.name === 'save_issue');
		expect(save?.args).toEqual({id: 'ENG-5', assignee: null, priority: 0, state: 'Done'});
	});

	test('nothing written differently saves nothing', async () => {
		const {linearConnector} = await import('./linear-connector');
		await linearConnector.update(target, 'ENG-5', CURRENT);

		expect(tools.calls.map((call) => call.name)).toEqual(['get_issue', 'get_issue', 'list_comments']);
	});

	test('moved to another team, the issue is opened by its new identifier', async () => {
		const {linearConnector} = await import('./linear-connector');
		const record = (await linearConnector.update(target, 'ENG-5', {...CURRENT, team: 'Design'})).unwrap();

		expect(record.id).toBe('ENG-6');
	});

	test('a title, a team or a status cannot be emptied', async () => {
		const {linearConnector} = await import('./linear-connector');

		expect((await linearConnector.update(target, 'ENG-5', {...CURRENT, status: ''})).unwrapErr()).toEqual(ApiErr.validationError('An issue needs a status'));
		expect(tools.calls.some((call) => call.name === 'save_issue')).toBe(false);
	});
});

test('issues are not deleted', async () => {
	const {linearConnector} = await import('./linear-connector');

	expect((await linearConnector.remove(target, 'ENG-5')).unwrapErr().kind).toBe('validation_error');
});
