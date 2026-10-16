import type {Result} from 'ts-results-es';
import {z} from 'zod';

import {ApiErr, type ApiError, Do, parseSchema, requirePresent} from '@proxy/utils';
import {getWriteTarget} from '@proxy/db/write-target';

import type {AuthenticatedRequest} from '../server/middleware/require-auth';
import {requireUserOrgId} from '../utils/user-org';
import type {DataRecord} from '../records/connector';
import type {EmailSearch} from '../records/email-search';
import {eachSource, type Failure} from './each-source';
import {searchable} from './mail-searches';
import {findSources, requireWritable, summarize, type Source, type SourceSummary} from './sources';
import {afterWrite} from './writes';

/**
 * Email for the Find email and Write email widgets: a search of every mailbox connected, each in
 * its own terms, newest first across them, and an email written from the mailbox picked, saved
 * as a draft or sent, through the mailbox's connector as an agent's would be.
 */

export type FoundEmail = {connectionId: string; id: string; from: string; subject: string; date: string; unread: boolean; link: string | null};

// What the widget lists at most, across every mailbox.
const LIMIT = 8;

function foundEmail(source: Source, record: DataRecord): FoundEmail {
	const {values} = record;
	return {
		connectionId: source.connection.id,
		id: record.id,
		from: values.from ?? '',
		subject: values.subject ?? '',
		date: values.date ?? record.updatedAt,
		unread: (values.status ?? '').startsWith('Unread'),
		link: record.url ?? null,
	};
}

const searchSchema = z.object({
	from: z.string().trim().max(200).optional(),
	words: z.union([z.string(), z.array(z.string())]).optional(),
	since: z.iso.date().optional(),
});

function readSearch(query: z.infer<typeof searchSchema>): EmailSearch {
	const words = query.words === undefined ? [] : Array.isArray(query.words) ? query.words : [query.words];
	return {
		from: query.from || null,
		// Each term's words, any of which will do, joined by " | ".
		words: words
			.map((term) =>
				term
					.split('|')
					.map((word) => word.trim().slice(0, 100))
					.filter((word) => word !== '')
					.slice(0, 10),
			)
			.filter((term) => term.length > 0)
			.slice(0, 10),
		since: query.since ?? null,
	};
}

export type FoundEmails = {sources: SourceSummary[]; emails: FoundEmail[]; failed: Failure[]};

/** `GET /api/widgets/emails?from=…&words=…&since=…`: the newest emails each mailbox finds. */
export function handleFindEmailsRoute(request: AuthenticatedRequest): Promise<Result<FoundEmails, ApiError>> {
	return Do(async ($) => {
		const search = readSearch($(parseSchema(searchSchema, request.query)));
		const orgId = $(await requireUserOrgId(request));
		const sources = searchable($(await findSources(orgId, 'emails', 'list')));
		const {found, failed} = await eachSource(sources, (source) => source.find(source, search, LIMIT));
		const emails = found
			.flatMap(({source, value}) => value.map((record) => foundEmail(source, record)))
			.sort((a, b) => Date.parse(b.date) - Date.parse(a.date))
			.slice(0, LIMIT);
		return {sources: sources.map(summarize), emails, failed};
	});
}

export type Mailboxes = {sources: SourceSummary[]; target: string | null};

/** `GET /api/widgets/mailboxes`: the mailboxes email can go out from, the one last written from first. */
export function handleMailboxesRoute(request: AuthenticatedRequest): Promise<Result<Mailboxes, ApiError>> {
	return Do(async ($) => {
		const orgId = $(await requireUserOrgId(request));
		const sources = $(await findSources(orgId, 'emails', 'sendNew')).map(summarize);
		const last = $(await getWriteTarget(request.user.userId, 'emails'));
		const kept = sources.find((source) => source.connectionId === last?.connectionId);
		return {sources, target: (kept ?? sources[0])?.connectionId ?? null};
	});
}

const writeSchema = z.object({
	connectionId: z.string().min(1),
	to: z.array(z.email()).min(1).max(100),
	subject: z.string().trim().max(1000).default(''),
	body: z.string().max(100_000).default(''),
	// Sent at once, or saved as a draft.
	send: z.boolean(),
});

export type WrittenEmail = {sent: boolean};

/** `POST /api/widgets/emails`: an email from the mailbox picked, sent or saved as a draft. */
export function handleWriteEmailRoute(request: AuthenticatedRequest): Promise<Result<WrittenEmail, ApiError>> {
	return Do(async ($) => {
		const body = $(parseSchema(writeSchema, request.body));
		const orgId = $(await requireUserOrgId(request));
		const values = {to: body.to.join(', '), subject: body.subject, body: body.body};
		const write = body.send ? 'sendNew' : 'create';
		const source = $(await requireWritable(orgId, body.connectionId, 'emails', write, Object.keys(values)));
		if (!body.send) {
			$(await source.connector.create(source, values, null));
		}
		if (body.send) {
			const sendNew = $(requirePresent(source.connector.newCommands?.sendNew, ApiErr.forbidden()));
			$(await sendNew(source, values));
		}
		await afterWrite({orgId, userId: request.user.userId, source, action: write, title: body.subject, parent: null});
		return {sent: body.send};
	});
}
