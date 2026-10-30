import type {Result} from 'ts-results-es';
import {z} from 'zod';

import {ApiErr, type ApiError, Do, parseSchema, requirePresent} from '@proxy/utils';
import {getWriteTarget} from '@proxy/db/write-target';

import type {AuthenticatedRequest} from '../server/middleware/require-auth';
import {requireViewer} from '../utils/user-org';
import type {DataRecord} from '../records/connector';
import type {EmailSearch} from '../records/email-search';
import {eachSource, type Failure} from './each-source';
import {findSources, requireReadable, requireWritable, summarize, withCapability, type Source, type SourceSummary} from './sources';
import {afterWrite} from './writes';

/**
 * Email for the Find email, Write email and Reply to email widgets: a search of every mailbox
 * connected, each in its own terms, newest first across them, an email written from the mailbox
 * picked, and a reply to an email found, in its thread, from the mailbox it was found in, each
 * saved as a draft or sent, through the mailbox's connector as an agent's would be.
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
		const viewer = $(await requireViewer(request));
		const sources = withCapability($(await findSources(viewer, 'emails', 'list')), 'findEmails');
		const {found, failed} = await eachSource(sources, (source, signal) => source.connector.findEmails(source, [search], LIMIT, signal));
		const emails = found
			.flatMap(({source, value: [records = []]}) => records.map((record) => foundEmail(source, record)))
			.sort((a, b) => Date.parse(b.date) - Date.parse(a.date))
			.slice(0, LIMIT);
		return {sources: sources.map(summarize), emails, failed};
	});
}

export type Mailboxes = {sources: SourceSummary[]; target: string | null};

/** `GET /api/widgets/mailboxes`: the mailboxes email can go out from, the one last written from first. */
export function handleMailboxesRoute(request: AuthenticatedRequest): Promise<Result<Mailboxes, ApiError>> {
	return Do(async ($) => {
		const viewer = $(await requireViewer(request));
		const sources = $(await findSources(viewer, 'emails', 'sendNew')).map(summarize);
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
		const viewer = $(await requireViewer(request));
		const values = {to: body.to.join(', '), subject: body.subject, body: body.body};
		const write = body.send ? 'sendNew' : 'create';
		const source = $(await requireWritable(viewer, body.connectionId, 'emails', write, Object.keys(values)));
		if (!body.send) {
			const create = $(requirePresent(source.connector.create, ApiErr.forbidden()));
			$(await create(source, values, null));
		}
		if (body.send) {
			const sendNew = $(requirePresent(source.connector.newCommands?.sendNew, ApiErr.forbidden()));
			$(await sendNew(source, values));
		}
		await afterWrite({viewer, source, action: write, title: body.subject, parent: null});
		return {sent: body.send};
	});
}

const replySchema = z.object({
	connectionId: z.string().min(1),
	// The email answered, as the search found it.
	emailId: z.string().min(1).max(500),
	body: z.string().max(100_000),
	// Sent at once, or saved as a draft.
	send: z.boolean(),
});

/** `POST /api/widgets/emails/reply`: a reply to an email found, from the mailbox it is in, in its thread, sent or saved as a draft. */
export function handleReplyEmailRoute(request: AuthenticatedRequest): Promise<Result<WrittenEmail, ApiError>> {
	return Do(async ($) => {
		const body = $(parseSchema(replySchema, request.body));
		const viewer = $(await requireViewer(request));
		const write = body.send ? 'sendNew' : 'create';
		const source = $(await requireWritable(viewer, body.connectionId, 'emails', write, ['to', 'subject', 'body']));
		$(await requireReadable(viewer, body.connectionId, 'emails'));
		const reply = $(requirePresent(source.connector.reply, ApiErr.forbidden()));
		const written = $(await reply(source, body.emailId, {body: body.body, send: body.send, all: false}));
		await afterWrite({viewer, source, action: write, title: written.subject, parent: undefined});
		return {sent: body.send};
	});
}
