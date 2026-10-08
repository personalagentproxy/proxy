import {describe, expect, test} from 'bun:test';

import {ApiErr} from '@proxy/utils';

import {isLinearCursor, LINEAR, parseIssueIdentifier, parseLinearComments, parseLinearIssue, parseLinearIssues} from './linear-mcp';

// What list_issues answers, as Linear sends it.
const LISTED = JSON.stringify({
	issues: [
		{id: 'ENG-5', title: 'Fix the login page', team: 'Engineering', status: 'In Progress', statusType: 'started', assignee: 'Sam Lee', updatedAt: '2026-10-08T08:19:22.922Z'},
		{id: 'ENG-4', title: '', team: 'Engineering', status: 'Todo', statusType: 'unstarted', assignee: null, updatedAt: '2026-10-08T08:10:32.991Z'},
	],
	hasNextPage: true,
	cursor: '7c8fec34-211d-4973-b539-3af08917e3d1',
});

// What get_issue answers for the fields asked for.
const ISSUE = JSON.stringify({
	title: 'Fix the login page',
	description: 'The **button** is gone',
	status: 'In Progress',
	statusType: 'started',
	priority: {value: 2, name: 'High'},
	assignee: 'Sam Lee',
	createdBy: 'Alex Kim',
	project: null,
	labels: ['Bug', 'Frontend'],
	team: 'Engineering',
	dueDate: '2026-10-20',
	url: 'https://linear.app/acme/issue/ENG-5/fix-the-login-page',
	updatedAt: '2026-10-08T08:16:23.137Z',
	id: 'ENG-5',
});

describe('parseLinearIssues', () => {
	test("reads each issue's fields, the status type as the catalog names it, and the next cursor", () => {
		expect(parseLinearIssues(LISTED).unwrap()).toEqual({
			issues: [
				{
					id: 'ENG-5',
					title: 'Fix the login page',
					team: 'Engineering',
					status: 'In Progress',
					statusType: 'Started',
					priority: '',
					assignee: 'Sam Lee',
					project: '',
					labels: [],
					dueDate: '',
					createdBy: '',
					url: '',
					updatedAt: '2026-10-08T08:19:22.922Z',
					description: '',
				},
				expect.objectContaining({id: 'ENG-4', title: 'Untitled issue', statusType: 'Unstarted', assignee: ''}),
			],
			nextCursor: '7c8fec34-211d-4973-b539-3af08917e3d1',
		});
	});

	test('the last page has no cursor', () => {
		expect(parseLinearIssues(JSON.stringify({issues: [], hasNextPage: false})).unwrap()).toEqual({issues: [], nextCursor: null});
	});
});

describe('parseLinearIssue', () => {
	test('reads the priority by its number and the labels in order', () => {
		expect(parseLinearIssue(ISSUE).unwrap()).toMatchObject({
			id: 'ENG-5',
			priority: 'High',
			labels: ['Bug', 'Frontend'],
			project: '',
			dueDate: '2026-10-20',
			createdBy: 'Alex Kim',
			description: 'The **button** is gone',
		});
	});

	test('anything but an issue is Linear out of reach', () => {
		expect(parseLinearIssue('not json').unwrapErr().kind).toBe('provider_unreachable');
	});
});

describe('parseLinearComments', () => {
	test('oldest first, marking replies, what inline comments quote, and whom an agent wrote for', () => {
		const text = JSON.stringify({
			comments: [
				{id: 'c3', body: 'Done', createdAt: '2026-10-08T09:00:00.000Z', parentId: 'c1', quotedText: null, author: {id: 'u2', name: 'Bot'}, onBehalfOf: {id: 'u1', name: 'Sam Lee'}},
				{id: 'c1', body: 'Can you look?', createdAt: '2026-10-08T08:00:00.000Z', parentId: null, quotedText: 'the button', author: {id: 'u3', name: 'Alex Kim'}, onBehalfOf: null},
			],
			hasNextPage: true,
		});

		expect(parseLinearComments(text).unwrap()).toEqual({
			comments: [
				{author: 'Alex Kim', createdAt: '2026-10-08T08:00:00.000Z', reply: false, quote: 'the button', body: 'Can you look?'},
				{author: 'Bot for Sam Lee', createdAt: '2026-10-08T09:00:00.000Z', reply: true, quote: '', body: 'Done'},
			],
			more: true,
		});
	});
});

describe('parseIssueIdentifier and isLinearCursor', () => {
	test('take an identifier, in any case, and a cursor, and nothing else', () => {
		expect(parseIssueIdentifier('eng-12')).toBe('ENG-12');
		expect(parseIssueIdentifier('me')).toBeNull();
		expect(parseIssueIdentifier('30c25dd7-f6b6-4c9a-b28c-59540baef6c8')).toBeNull();
		expect(isLinearCursor('7c8fec34-211d-4973-b539-3af08917e3d1')).toBe(true);
		expect(isLinearCursor('next')).toBe(false);
	});
});

describe("LINEAR's tool errors", () => {
	const toolError = (text: string) => LINEAR.toolError?.(text) ?? null;

	test('an issue Linear has no such one of is not found', () => {
		expect(toolError(JSON.stringify({error: 'invalid_request', message: 'Could not find referenced Issue.', status: 400}))).toEqual(ApiErr.notFound('issue'));
		expect(toolError('Error: Could not find issue "ENG-999". To create a new issue, omit the "id" parameter.')).toEqual(ApiErr.notFound('issue'));
	});

	test('a write Linear turns down says why, for the agent to try again', () => {
		expect(toolError('Error: Could not find team "Nope"')).toEqual(ApiErr.validationError('Linear turned it down: Could not find team "Nope"'));
		expect(toolError(JSON.stringify({error: 'invalid_request', message: 'after is not a valid pagination cursor identifier.'}))).toEqual(
			ApiErr.validationError('Linear turned it down: after is not a valid pagination cursor identifier.'),
		);
	});

	test('anything else is left to mean Linear out of reach', () => {
		expect(toolError(JSON.stringify({error: 'ratelimited', message: 'Too many requests', status: 429}))).toBeNull();
		expect(toolError('Something went wrong')).toBeNull();
	});
});
