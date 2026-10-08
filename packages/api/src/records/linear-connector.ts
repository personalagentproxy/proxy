import {Err, Ok, type Result} from 'ts-results-es';

import {ApiErr, type ApiError, Do} from '@proxy/utils';
import {LINEAR_PRIORITIES} from '@proxy/integrations';

import {
	isLinearCursor,
	ISSUE_FIELDS,
	LINEAR,
	LIST_FIELDS,
	parseIssueIdentifier,
	parseLinearComments,
	parseLinearIssue,
	parseLinearIssues,
	type LinearComment,
	type LinearIssue,
} from '../connections/linear/linear-mcp';
import {callMcpToolFor} from '../connections/mcp/mcp-session';
import type {Connector, DataRecord, ListQuery, RecordPage, RecordTarget, RecordValues} from './connector';

/**
 * A Linear workspace's issues, fetched live from Linear's MCP server as the person who signed in,
 * by their identifier, `ENG-123`. A list is the issues updated last first, 50 to a page with
 * Linear's cursor, narrowed to a type of status and searched in titles and descriptions. An issue
 * opens with its comments, oldest first, the latest 250 of them.
 *
 * Teams, statuses, people, projects and labels are written by name, and Linear finds them,
 * turning down a name it doesn't know. An edit sends only the fields written differently, an empty
 * one clearing it. Issues aren't deleted.
 */

const PAGE_SIZE = 50;
const COMMENT_LIMIT = 250;

function callLinear(target: RecordTarget, name: string, args: Record<string, unknown>): Promise<Result<string, ApiError>> {
	return callMcpToolFor(LINEAR, target.connection, name, args);
}

function summaryValues(issue: LinearIssue): RecordValues {
	return {title: issue.title, team: issue.team, status: issue.status, statusType: issue.statusType, assignee: issue.assignee, updated: issue.updatedAt};
}

function issueValues(issue: LinearIssue): RecordValues {
	return {
		...summaryValues(issue),
		priority: issue.priority,
		project: issue.project,
		labels: issue.labels.join(', '),
		dueDate: issue.dueDate,
		createdBy: issue.createdBy,
		link: issue.url,
		description: issue.description,
	};
}

function toRecord(issue: LinearIssue, values: RecordValues): DataRecord {
	return {id: issue.id, values, updatedAt: issue.updatedAt};
}

// "Sam Lee · 2026-10-08 08:16 UTC", a reply's marked, then what an inline comment quotes and what was written.
function commentText(comment: LinearComment): string {
	const when = comment.createdAt.slice(0, 16).replace('T', ' ');
	const heading = `${comment.reply ? 'Reply from ' : ''}${comment.author} · ${when} UTC`;
	const quote = comment.quote ? `${comment.quote.replace(/^/gm, '> ')}\n\n` : '';
	return `${heading}\n${quote}${comment.body}`;
}

function commentsText(comments: LinearComment[], more: boolean): string {
	const text = comments.map(commentText).join('\n\n---\n\n');
	return more ? `Older comments are left out.\n\n---\n\n${text}` : text;
}

function notFoundAs(recordId: string) {
	return (error: ApiError): ApiError => (error.kind === 'not_found' ? ApiErr.notFound('record', recordId) : error);
}

function fetchIssue(target: RecordTarget, recordId: string): Promise<Result<LinearIssue, ApiError>> {
	return Do(async ($) => {
		const id = parseIssueIdentifier(recordId);
		if (!id) {
			return $(Err(ApiErr.notFound('record', recordId)));
		}
		const text = $((await callLinear(target, 'get_issue', {id, fields: ISSUE_FIELDS})).mapErr(notFoundAs(recordId)));
		return $(parseLinearIssue(text));
	});
}

function getIssue(target: RecordTarget, recordId: string): Promise<Result<DataRecord, ApiError>> {
	return Do(async ($) => {
		const issue = $(await fetchIssue(target, recordId));
		const text = $(await callLinear(target, 'list_comments', {issueId: issue.id, orderBy: 'createdAt', limit: COMMENT_LIMIT}));
		const {comments, more} = $(parseLinearComments(text));
		return toRecord(issue, {...issueValues(issue), comments: commentsText(comments, more)});
	});
}

// "Bug, Frontend" as Linear's labels take them.
function labelList(written: string): string[] {
	return written
		.split(',')
		.map((label) => label.trim())
		.filter((label) => label !== '');
}

// What `save_issue` takes for one field written in, an empty one clearing it; Linear can't clear a
// title, a team or a status.
function fieldArg(key: string, value: string): Result<Record<string, unknown>, ApiError> {
	const trimmed = value.trim();
	if (key === 'title' || key === 'team' || key === 'status') {
		if (trimmed === '') {
			return Err(ApiErr.validationError(`An issue needs a ${key}`));
		}
		return Ok({[key === 'status' ? 'state' : key]: trimmed});
	}
	if (key === 'priority') {
		return Ok({priority: Math.max(LINEAR_PRIORITIES.indexOf(value), 0)});
	}
	if (key === 'labels') {
		return Ok({labels: labelList(value)});
	}
	if (key === 'description') {
		return Ok({description: value});
	}
	if (key === 'assignee' || key === 'project' || key === 'dueDate') {
		return Ok({[key]: trimmed === '' ? null : trimmed});
	}
	return Err(ApiErr.validationError(`${key} can't be set`));
}

// The fields a write sets, as `save_issue` takes them.
function saveArgs(fields: RecordValues): Result<Record<string, unknown>, ApiError> {
	const args: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(fields)) {
		const arg = fieldArg(key, value);
		if (arg.isErr()) {
			return arg;
		}
		Object.assign(args, arg.value);
	}
	return Ok(args);
}

// Labels the same whatever their order and spacing.
function labelSet(written: string): string {
	return labelList(written).sort().join('\n');
}

// Whether a field is written as the issue already has it.
function unchanged(key: string, value: string, current: RecordValues): boolean {
	if (key === 'labels') {
		return labelSet(value) === labelSet(current.labels ?? '');
	}
	if (key === 'description') {
		return value === (current.description ?? '');
	}
	return value.trim() === (current[key] ?? '');
}

function list(target: RecordTarget, query: ListQuery): Promise<Result<RecordPage, ApiError>> {
	return Do(async ($) => {
		if (query.page !== null && !isLinearCursor(query.page)) {
			return $(Err(ApiErr.validationError('Not a page of Linear issues')));
		}
		const text = $(
			await callLinear(target, 'list_issues', {
				limit: PAGE_SIZE,
				orderBy: 'updatedAt',
				fields: LIST_FIELDS,
				...(query.page ? {cursor: query.page} : {}),
				...(query.search ? {query: query.search} : {}),
				...(query.filter ? {state: query.filter.toLowerCase()} : {}),
			}),
		);
		const page = $(parseLinearIssues(text));
		return {records: page.issues.map((issue) => toRecord(issue, summaryValues(issue))), nextPage: page.nextCursor};
	});
}

export const linearConnector: Connector = {
	list,
	get: getIssue,
	// Every field typed in, the empty ones left out: Linear gives a new issue its team's defaults.
	create: (target, values) =>
		Do(async ($) => {
			const written = Object.fromEntries(Object.entries(values).filter(([, value]) => value.trim() !== ''));
			const args = $(saveArgs({title: '', team: '', ...written}));
			const created = $(parseLinearIssue($(await callLinear(target, 'save_issue', args))));
			return $(await getIssue(target, created.id));
		}),
	update: (target, recordId, values) =>
		Do(async ($) => {
			const issue = $(await fetchIssue(target, recordId));
			const current = issueValues(issue);
			const changed = Object.fromEntries(Object.entries(values).filter(([key, value]) => !unchanged(key, value, current)));
			if (Object.keys(changed).length === 0) {
				return $(await getIssue(target, issue.id));
			}
			// Moved to another team, the issue has a new identifier.
			const saved = $(parseLinearIssue($(await callLinear(target, 'save_issue', {id: issue.id, ...$(saveArgs(changed))}))));
			return $(await getIssue(target, saved.id));
		}),
	remove: () => Promise.resolve(Err(ApiErr.validationError('Linear issues are not deleted here'))),
};
