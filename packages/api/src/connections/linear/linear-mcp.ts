import {Err, Result} from 'ts-results-es';
import {z} from 'zod';

import {ApiErr, type ApiError, Do, parseSchema} from '@proxy/utils';
import {LINEAR_PRIORITIES, LINEAR_STATUS_TYPES} from '@proxy/integrations';

import {callMcpTool} from '../mcp/mcp-client';
import type {McpServer, McpSignIn} from '../mcp/mcp-oauth';

/**
 * Linear's MCP server and what its tools answer: JSON, issues with their team, status, assignee,
 * project and labels by name, as Linear shows them and as its tools take them back. A sign-in is
 * for one workspace, as the person who signed in.
 */

const BASE = 'https://mcp.linear.app';

// What a read that failed says: `{"error": "invalid_request", "message": "Could not find referenced Issue.", "status": 400}`.
const toolFailureSchema = z.object({error: z.string(), message: z.string().optional(), status: z.number().optional()});

// A write Linear turns down says why in words, for the model to try again: `Error: Could not find team "Nope"`.
const REFUSAL = /^Error: (.+)/s;

function linearToolError(text: string): ApiError | null {
	const refusal = REFUSAL.exec(text.trim());
	if (refusal?.[1]) {
		return /^Could not find issue\b/.test(refusal[1]) ? ApiErr.notFound('issue') : ApiErr.validationError(`Linear turned it down: ${refusal[1]}`);
	}

	const failure = parseJson(text, toolFailureSchema);
	if (failure.isErr() || failure.value.error !== 'invalid_request') {
		return null;
	}
	if (/^Could not find referenced/.test(failure.value.message ?? '')) {
		return ApiErr.notFound('issue');
	}
	return ApiErr.validationError(`Linear turned it down: ${failure.value.message ?? 'not valid'}`);
}

export const LINEAR: McpServer = {
	name: 'Linear',
	url: `${BASE}/mcp`,
	registerUrl: `${BASE}/register`,
	authorizeUrl: `${BASE}/authorize`,
	tokenUrl: `${BASE}/token`,
	scope: 'read write',
	toolError: linearToolError,
};

function parseJson<T>(text: string, schema: z.ZodType<T>): Result<T, ApiError> {
	return Result.wrap((): unknown => JSON.parse(text))
		.mapErr((cause) => ApiErr.providerUnreachable(cause))
		.andThen((json) => parseSchema(schema, json).mapErr((error) => ApiErr.providerUnreachable(error)));
}

const userSchema = z.object({name: z.string().optional(), email: z.string().optional()});
const workspaceSchema = z.object({name: z.string()});

/**
 * The Linear account a sign-in is for, by who signed in and their workspace:
 * "alex@example.com · Acme". Signing in to another workspace is another connection.
 */
export function getLinearAccount(signIn: McpSignIn): Promise<Result<string, ApiError>> {
	return Do(async ($) => {
		const token = signIn.credential.accessToken;
		const [userText, workspaceText] = await Promise.all([callMcpTool(LINEAR, token, 'get_user', {query: 'me'}), callMcpTool(LINEAR, token, 'get_workspace', {})]);
		const user = $(parseJson($(userText), userSchema));
		const workspace = $(parseJson($(workspaceText), workspaceSchema));
		const who = user.email?.toLowerCase() ?? user.name;
		if (!who) {
			return $(Err(ApiErr.providerUnreachable(new Error('Linear did not say who signed in'))));
		}
		return `${who} · ${workspace.name}`;
	});
}

// An issue's identifier, its team's key and its number: `ENG-123`.
const IDENTIFIER = /^[A-Z0-9_]+-\d+$/i;

/** An issue's identifier as Linear writes it, `ENG-123`; null for anything else. */
export function parseIssueIdentifier(recordId: string): string | null {
	return IDENTIFIER.test(recordId) ? recordId.toUpperCase() : null;
}

// What a page token is: the cursor Linear gave, the id of the last issue on the page before.
const CURSOR = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isLinearCursor(page: string): boolean {
	return CURSOR.test(page);
}

export type LinearIssue = {
	// `ENG-123`.
	id: string;
	title: string;
	team: string;
	status: string;
	// One of `LINEAR_STATUS_TYPES`, or empty when Linear names one it doesn't have.
	statusType: string;
	// One of `LINEAR_PRIORITIES`.
	priority: string;
	assignee: string;
	project: string;
	labels: string[];
	// `2026-10-20`, or empty.
	dueDate: string;
	createdBy: string;
	url: string;
	updatedAt: string;
	description: string;
};

/** The fields asked for when listing issues, and when opening one. */
export const LIST_FIELDS = ['id', 'title', 'team', 'status', 'statusType', 'assignee', 'updatedAt'];
export const ISSUE_FIELDS = [...LIST_FIELDS, 'priority', 'project', 'labels', 'dueDate', 'createdBy', 'url', 'description'];

// Every field asked for is there, null when it has no value; those not asked for are left out.
const text = z.string().nullish();

const issueSchema = z.object({
	id: z.string().min(1),
	title: text,
	team: text,
	status: text,
	statusType: text,
	priority: z.object({value: z.number(), name: z.string()}).nullish(),
	assignee: text,
	project: text,
	labels: z.array(z.string()).nullish(),
	dueDate: text,
	createdBy: text,
	url: text,
	updatedAt: text,
	description: text,
});

const issuesSchema = z.object({issues: z.array(issueSchema), hasNextPage: z.boolean(), cursor: z.string().optional()});

function statusTypeOf(type: string | null | undefined): string {
	return LINEAR_STATUS_TYPES.find((candidate) => candidate.toLowerCase() === type) ?? '';
}

function toIssue(issue: z.infer<typeof issueSchema>): LinearIssue {
	return {
		id: issue.id,
		title: issue.title || 'Untitled issue',
		team: issue.team ?? '',
		status: issue.status ?? '',
		statusType: statusTypeOf(issue.statusType),
		priority: issue.priority ? (LINEAR_PRIORITIES[issue.priority.value] ?? issue.priority.name) : '',
		assignee: issue.assignee ?? '',
		project: issue.project ?? '',
		labels: issue.labels ?? [],
		dueDate: issue.dueDate ?? '',
		createdBy: issue.createdBy ?? '',
		url: issue.url ?? '',
		updatedAt: issue.updatedAt ?? '',
		description: issue.description ?? '',
	};
}

/** A `list_issues` answer's issues, newest first as Linear sends them, and the next page's cursor. */
export function parseLinearIssues(text: string): Result<{issues: LinearIssue[]; nextCursor: string | null}, ApiError> {
	return parseJson(text, issuesSchema).map((page) => ({issues: page.issues.map(toIssue), nextCursor: page.hasNextPage ? (page.cursor ?? null) : null}));
}

/** A `get_issue` or `save_issue` answer's issue. */
export function parseLinearIssue(text: string): Result<LinearIssue, ApiError> {
	return parseJson(text, issueSchema).map(toIssue);
}

export type LinearComment = {
	author: string;
	createdAt: string;
	// A reply in a thread rather than the comment starting it.
	reply: boolean;
	// What an inline comment is about, from the issue's description.
	quote: string;
	body: string;
};

const commentsSchema = z.object({
	comments: z.array(
		z.object({
			body: z.string(),
			createdAt: z.string(),
			parentId: z.string().nullish(),
			quotedText: z.string().nullish(),
			author: z.object({name: z.string()}).nullish(),
			// The person an agent's comment was written for.
			onBehalfOf: z.object({name: z.string().optional()}).nullish(),
		}),
	),
	hasNextPage: z.boolean(),
});

/** A `list_comments` answer's comments, oldest first, and whether there are older ones it left out. */
export function parseLinearComments(text: string): Result<{comments: LinearComment[]; more: boolean}, ApiError> {
	return parseJson(text, commentsSchema).map((page) => ({
		comments: page.comments
			.map((comment) => {
				const author = comment.author?.name ?? 'Someone';
				const forWhom = comment.onBehalfOf?.name;
				return {
					author: forWhom ? `${author} for ${forWhom}` : author,
					createdAt: comment.createdAt,
					reply: Boolean(comment.parentId),
					quote: comment.quotedText ?? '',
					body: comment.body,
				};
			})
			.sort((a, b) => a.createdAt.localeCompare(b.createdAt)),
		more: page.hasNextPage,
	}));
}
