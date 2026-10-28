import {Ok, type Result} from 'ts-results-es';
import {z} from 'zod';

import {type ApiError, mapWithLimit} from '@proxy/utils';

import {decodeText} from '../../utils/decode-text';
import {htmlToText} from '../../utils/html-to-text';
import {googleDelete, googleRequest, googleWrite} from './google-client';

/**
 * The Gmail v1 calls the `emails` collection makes, the reading of their answers, and Gmail's
 * labels as the collection's folders. A message is read as Gmail parses it: its headers, and its
 * MIME parts with each part's content in base64url.
 */

const GMAIL = 'https://gmail.googleapis.com/gmail/v1/users/me';

export const PAGE_SIZE = 50;

// Messages opened at once for a list: Gmail's per-user quota allows far more, but a page of 50 at
// once is a burst it may turn down.
const CONCURRENCY = 8;

// Drafts asked for at once when finding a draft's id from its message's.
const DRAFTS_PAGE_SIZE = 500;

/** Gmail's message and draft ids, as every id an agent sends is checked against before it reaches an address. */
export const GMAIL_ID = /^[A-Za-z0-9_-]+$/;

/** The headers a list reads of each message, and Cc, which the home page's widgets read. */
const LIST_HEADERS = ['Subject', 'From', 'To', 'Cc'];

const headerSchema = z.object({name: z.string(), value: z.string()});

export type MessagePart = {
	mimeType?: string;
	filename?: string;
	headers?: Array<z.infer<typeof headerSchema>>;
	body?: {size?: number; data?: string; attachmentId?: string};
	parts?: MessagePart[];
};

const partSchema: z.ZodType<MessagePart> = z.object({
	mimeType: z.string().optional(),
	filename: z.string().optional(),
	headers: z.array(headerSchema).optional(),
	body: z.object({size: z.number().optional(), data: z.string().optional(), attachmentId: z.string().optional()}).optional(),
	get parts() {
		return z.array(partSchema).optional();
	},
});

const messageSchema = z.object({
	id: z.string(),
	threadId: z.string().optional(),
	labelIds: z.array(z.string()).optional(),
	// Milliseconds since 1970, as text.
	internalDate: z.string().optional(),
	payload: partSchema.optional(),
});

export type GmailMessage = z.infer<typeof messageSchema>;

const messageListSchema = z.object({messages: z.array(z.object({id: z.string()})).optional(), nextPageToken: z.string().optional()});

const draftSchema = z.object({id: z.string(), message: messageSchema});

export type GmailDraft = z.infer<typeof draftSchema>;

const draftListSchema = z.object({drafts: z.array(z.object({id: z.string(), message: z.object({id: z.string()})})).optional(), nextPageToken: z.string().optional()});

export type DraftRef = {draftId: string; messageId: string};

export type Page<T> = {items: T[]; nextPage: string | null};

// A parameter given several times, such as `labelIds`, is a list; one left out is null.
type Params = Record<string, string | string[] | null>;

function gmailUrl(path: string, params: Params = {}): URL {
	const url = new URL(`${GMAIL}${path}`);
	for (const [name, value] of Object.entries(params)) {
		for (const each of [value ?? []].flat()) {
			url.searchParams.append(name, each);
		}
	}
	return url;
}

/** A message as base64url of its RFC 2822 text, as Gmail takes one to send or save as a draft. */
export function rawMessage(source: Buffer, threadId: string | null): {raw: string; threadId?: string} {
	return {raw: source.toString('base64url'), ...(threadId ? {threadId} : {})};
}

// ---- Folders ---------------------------------------------------------------------------------

/** The folders an email can be in, each one of Gmail's labels or, for the archive, none of them. */
export type Folder = 'Inbox' | 'Draft' | 'Sent' | 'Archive' | 'Trash' | 'Spam';

// The labels that make a folder, in the order they win when a message has several: Trash before
// all, a draft in it included, and an email in the inbox before one sent, such as one sent to
// oneself.
const FOLDER_LABELS: Array<[string, Folder]> = [
	['TRASH', 'Trash'],
	['SPAM', 'Spam'],
	['DRAFT', 'Draft'],
	['INBOX', 'Inbox'],
	['SENT', 'Sent'],
];

/** The folder a message's labels put it in: an email with none of the folders' labels is archived. */
export function folderOf(labelIds: string[]): Folder {
	return FOLDER_LABELS.find(([label]) => labelIds.includes(label))?.[1] ?? 'Archive';
}

// The archive is All Mail without the other folders, which only a search can say.
const ARCHIVE_QUERY = '-in:inbox -in:sent -in:drafts -in:trash -in:spam';

/** What a list asks Gmail for, to list a folder: a label, or for the archive a search. Spam and Trash are left out unless asked for. */
export type FolderQuery = {labelIds: string[]; q: string | null; includeSpamTrash: boolean};

export function folderQuery(folder: string | null, search: string | null): FolderQuery {
	const label = FOLDER_LABELS.find(([, name]) => name === folder)?.[0];
	if (folder === 'Archive') {
		return {labelIds: [], q: search ? `${ARCHIVE_QUERY} (${search})` : ARCHIVE_QUERY, includeSpamTrash: false};
	}
	return {labelIds: label ? [label] : [], q: search, includeSpamTrash: label === 'TRASH' || label === 'SPAM'};
}

// ---- Reading a message -----------------------------------------------------------------------

/** A header of a message or a part, by its name in any case, or empty. */
export function headerOf(part: MessagePart | undefined, name: string): string {
	const lower = name.toLowerCase();
	return part?.headers?.find((header) => header.name.toLowerCase() === lower)?.value ?? '';
}

// A part's content, from base64url, as UTF-8 where it is, else in the charset its Content-Type
// names: a part naming ISO-8859-1 can come from Gmail as UTF-8, which read as ISO-8859-1 turns ä
// into Ã¤.
function decodePart(part: MessagePart): string {
	const charset = /charset="?([^";\s]+)"?/i.exec(headerOf(part, 'Content-Type'))?.[1] ?? null;
	return decodeText(Buffer.from(part.body?.data ?? '', 'base64url'), charset);
}

function isAttachment(part: MessagePart): boolean {
	return (part.filename ?? '') !== '';
}

// The first part of a type that holds text, depth first, attachments left out.
function findText(part: MessagePart, mimeType: string): MessagePart | null {
	if (isAttachment(part)) {
		return null;
	}
	if (part.mimeType === mimeType && part.body?.data) {
		return part;
	}
	for (const child of part.parts ?? []) {
		const found = findText(child, mimeType);
		if (found) {
			return found;
		}
	}
	return null;
}

/**
 * One of a message's attachments: its content is in the message, as a small one's may be, or is
 * fetched by its `attachmentId`, which Gmail gives anew every time the message is read.
 */
export type GmailAttachment = {name: string; type: string; size: number; data: string | null; attachmentId: string | null};

/** A message's attachments, inline images included, in the order of its parts. */
export function attachmentsOf(part: MessagePart | undefined): GmailAttachment[] {
	if (!part) {
		return [];
	}
	const own = isAttachment(part)
		? [{name: part.filename ?? '', type: part.mimeType ?? '', size: part.body?.size ?? 0, data: part.body?.data ?? null, attachmentId: part.body?.attachmentId ?? null}]
		: [];
	return [...own, ...(part.parts ?? []).flatMap(attachmentsOf)];
}

/** A message's HTML part, as its sender wrote it, or null for one without. */
export function messageHtml(payload: MessagePart | undefined): string | null {
	const html = payload ? findText(payload, 'text/html') : null;
	return html ? decodePart(html) : null;
}

/** A message's text: its plain text part, else its HTML part as text. */
export function messageBody(payload: MessagePart | undefined): string {
	if (!payload) {
		return '';
	}
	const plain = findText(payload, 'text/plain');
	if (plain) {
		return decodePart(plain).replace(/\r\n?/g, '\n').trim();
	}
	const html = findText(payload, 'text/html');
	return html ? htmlToText(decodePart(html)) : '';
}

// ---- Calls -----------------------------------------------------------------------------------

/** One page of message ids, newest first, in a folder and matching a search, from the page a previous one pointed at, of 50 unless asked for fewer. */
export async function listMessageIds(accessToken: string, query: FolderQuery, pageToken: string | null, pageSize = PAGE_SIZE): Promise<Result<Page<string>, ApiError>> {
	const params = {maxResults: String(pageSize), labelIds: query.labelIds, q: query.q, includeSpamTrash: query.includeSpamTrash ? 'true' : null, pageToken};
	const list = await googleRequest(accessToken, gmailUrl('/messages', params), messageListSchema);
	return list.map(({messages = [], nextPageToken}) => ({items: messages.map(({id}) => id), nextPage: nextPageToken ?? null}));
}

/** One page of drafts, newest first, matching a search. */
export async function listDrafts(accessToken: string, search: string | null, pageToken: string | null, pageSize = PAGE_SIZE): Promise<Result<Page<DraftRef>, ApiError>> {
	const list = await googleRequest(accessToken, gmailUrl('/drafts', {maxResults: String(pageSize), q: search, pageToken}), draftListSchema);
	return list.map(({drafts = [], nextPageToken}) => ({items: drafts.map(({id, message}) => ({draftId: id, messageId: message.id})), nextPage: nextPageToken ?? null}));
}

// How many pages of drafts are looked through for a draft's id before giving up: 5,000 drafts.
const MAX_DRAFT_PAGES = 10;

/**
 * The draft ids of messages that are drafts, by message id. Gmail's messages don't say which
 * draft they are, so the drafts are listed until every one is found.
 */
export async function findDraftIds(accessToken: string, messageIds: string[]): Promise<Result<Map<string, string>, ApiError>> {
	const found = new Map<string, string>();
	let pageToken: string | null = null;
	for (let page = 0; page < MAX_DRAFT_PAGES && found.size < messageIds.length; page++) {
		const drafts = await listDrafts(accessToken, null, pageToken, DRAFTS_PAGE_SIZE);
		if (drafts.isErr()) {
			return drafts;
		}
		for (const {draftId, messageId} of drafts.value.items) {
			if (messageIds.includes(messageId)) {
				found.set(messageId, draftId);
			}
		}
		pageToken = drafts.value.nextPage;
		if (!pageToken) {
			break;
		}
	}
	return Ok(found);
}

// Waits before asking again a message Gmail answered busy, or failed on for a moment.
const RETRY_DELAYS_MS = [250, 1000];

const busySchema = z.object({kind: z.literal('http'), status: z.number().refine((status) => status === 429 || status >= 500)});

function isBusy(error: ApiError): boolean {
	return error.kind === 'provider_unreachable' && busySchema.safeParse(error.cause).success;
}

// A call asked again, twice at most, while Gmail answers it is busy, so one of a page's messages
// turned down in the burst doesn't fail the page.
async function retried<T>(call: () => Promise<Result<T, ApiError>>): Promise<Result<T, ApiError>> {
	let result = await call();
	for (const delay of RETRY_DELAYS_MS) {
		if (result.isOk() || !isBusy(result.error)) {
			return result;
		}
		await Bun.sleep(delay);
		result = await call();
	}
	return result;
}

/** A message with what a list shows of it: its labels, date and the headers in `LIST_HEADERS`. */
function getMessageSummary(accessToken: string, messageId: string): Promise<Result<GmailMessage, ApiError>> {
	return retried(() => googleRequest(accessToken, gmailUrl(`/messages/${messageId}`, {format: 'metadata', metadataHeaders: LIST_HEADERS}), messageSchema));
}

/** A message's labels alone, to tell a draft from other email. */
export function getMessageLabels(accessToken: string, messageId: string): Promise<Result<GmailMessage, ApiError>> {
	return googleRequest(accessToken, gmailUrl(`/messages/${messageId}`, {format: 'minimal'}), messageSchema);
}

/** The summaries of several messages, at most a few asked for at once, in the order of their ids. */
export function getMessageSummaries(accessToken: string, messageIds: string[]): Promise<Array<Result<GmailMessage, ApiError>>> {
	return mapWithLimit(messageIds, CONCURRENCY, (messageId) => getMessageSummary(accessToken, messageId));
}

/** A message whole: its headers and every part. */
export function getMessage(accessToken: string, messageId: string): Promise<Result<GmailMessage, ApiError>> {
	return googleRequest(accessToken, gmailUrl(`/messages/${messageId}`, {format: 'full'}), messageSchema);
}

const attachmentSchema = z.object({data: z.string()});

/** An attachment's content, by the id the message gave it when it was read. */
export async function getAttachment(accessToken: string, messageId: string, attachmentId: string): Promise<Result<Buffer, ApiError>> {
	const answer = await googleRequest(accessToken, gmailUrl(`/messages/${messageId}/attachments/${attachmentId}`), attachmentSchema);
	return answer.map(({data}) => Buffer.from(data, 'base64url'));
}

/** Adds and removes labels on a message, as marking, starring and archiving do. */
export function modifyMessage(accessToken: string, messageId: string, change: {add?: string[]; remove?: string[]}): Promise<Result<GmailMessage, ApiError>> {
	return googleWrite(accessToken, 'POST', gmailUrl(`/messages/${messageId}/modify`), {addLabelIds: change.add ?? [], removeLabelIds: change.remove ?? []}, messageSchema);
}

/** Moves a message to Trash, where Gmail keeps it 30 days. Nothing here deletes a message for good. */
export function trashMessage(accessToken: string, messageId: string): Promise<Result<GmailMessage, ApiError>> {
	return googleWrite(accessToken, 'POST', gmailUrl(`/messages/${messageId}/trash`), {}, messageSchema);
}

/** Sends a message; Gmail files it in Sent itself. */
export function sendMessage(accessToken: string, message: {raw: string; threadId?: string}): Promise<Result<GmailMessage, ApiError>> {
	return googleWrite(accessToken, 'POST', gmailUrl('/messages/send'), message, messageSchema);
}

/** A draft whole, its message with every part. */
export function getDraft(accessToken: string, draftId: string): Promise<Result<GmailDraft, ApiError>> {
	return googleRequest(accessToken, gmailUrl(`/drafts/${draftId}`, {format: 'full'}), draftSchema);
}

export function createDraft(accessToken: string, message: {raw: string; threadId?: string}): Promise<Result<GmailDraft, ApiError>> {
	return googleWrite(accessToken, 'POST', gmailUrl('/drafts'), {message}, draftSchema);
}

/** Replaces a draft's message; the draft keeps its id, its message gets a new one. */
export function updateDraft(accessToken: string, draftId: string, message: {raw: string; threadId?: string}): Promise<Result<GmailDraft, ApiError>> {
	return googleWrite(accessToken, 'PUT', gmailUrl(`/drafts/${draftId}`), {id: draftId, message}, draftSchema);
}

/** Deletes a draft for good, as Gmail's own Discard does. */
export function deleteDraft(accessToken: string, draftId: string): Promise<Result<void, ApiError>> {
	return googleDelete(accessToken, gmailUrl(`/drafts/${draftId}`));
}

/** Sends a draft as it is saved; it leaves the drafts, and its message is filed in Sent. */
export function sendDraft(accessToken: string, draftId: string): Promise<Result<GmailMessage, ApiError>> {
	return googleWrite(accessToken, 'POST', gmailUrl('/drafts/send'), {id: draftId}, messageSchema);
}
