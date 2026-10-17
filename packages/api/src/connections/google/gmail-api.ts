import {Ok, Result} from 'ts-results-es';
import {z} from 'zod';

import {type ApiError, mapWithLimit} from '@proxy/utils';

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

// A part's content, from base64url, in the charset its Content-Type names; one TextDecoder doesn't
// know is read as UTF-8.
function decodePart(part: MessagePart): string {
	const bytes = Buffer.from(part.body?.data ?? '', 'base64url');
	const charset = /charset="?([^";\s]+)"?/i.exec(headerOf(part, 'Content-Type'))?.[1] ?? 'utf-8';
	return Result.wrap(() => new TextDecoder(charset).decode(bytes)).unwrapOr(bytes.toString('utf8'));
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

/** The names of a message's attachments, inline images included, in the order of its parts. */
export function attachmentNames(part: MessagePart | undefined): string[] {
	if (!part) {
		return [];
	}
	const own = isAttachment(part) ? [part.filename ?? ''] : [];
	return [...own, ...(part.parts ?? []).flatMap(attachmentNames)];
}

const ENTITIES: Record<string, string> = {amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' '};

// A character by its number, or the replacement character for one Unicode doesn't have.
function codePoint(digits: string, radix: number): string {
	const value = Number.parseInt(digits, radix);
	if (!Number.isInteger(value) || value < 1 || value > 0x10ffff) {
		return '\uFFFD';
	}
	return String.fromCodePoint(value);
}

function decodeEntities(text: string): string {
	return text.replace(/&(#x[0-9a-f]{1,8}|#\d{1,8}|[a-z]{1,32});/gi, (entity, name: string) => {
		if (name.startsWith('#x') || name.startsWith('#X')) {
			return codePoint(name.slice(2), 16);
		}
		if (name.startsWith('#')) {
			return codePoint(name.slice(1), 10);
		}
		return ENTITIES[name.toLowerCase()] ?? entity;
	});
}

// Elements whose content is never text.
const HIDDEN = ['script', 'style', 'head', 'title'];

// Elements ending a line where they close.
const BLOCKS = ['p', 'div', 'tr', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'blockquote', 'table', 'ul', 'ol'];

// What a tag becomes in the text, by its name and whether it closes an element.
function tagText(name: string, closing: boolean): string {
	if (name === 'br') {
		return '\n';
	}
	if (name === 'li' && !closing) {
		return '\n- ';
	}
	if (closing && BLOCKS.includes(name)) {
		return '\n';
	}
	return '';
}

/**
 * HTML as plain text, for an email without a text part: blocks and line breaks as new lines, a
 * link's address after its text where they differ, everything else's tags dropped. Read in one
 * pass, each tag found from where the last ended, so the time it takes grows with the email's
 * length whatever its HTML looks like, unclosed tags and all.
 */
export function htmlToText(html: string): string {
	const parts: string[] = [];
	// The link being read: its address, and where its text starts among the parts.
	let link: {href: string; start: number} | null = null;
	let at = 0;
	while (at < html.length) {
		const open = html.indexOf('<', at);
		if (open === -1) {
			parts.push(sourceText(html.slice(at)));
			break;
		}
		parts.push(sourceText(html.slice(at, open)));
		// A < that starts no tag, as in "1 < 2", is text.
		if (!/[a-z/!?]/i.test(html.charAt(open + 1))) {
			parts.push('<');
			at = open + 1;
			continue;
		}
		if (html.startsWith('<!--', open)) {
			const end = html.indexOf('-->', open + 4);
			at = end === -1 ? html.length : end + 3;
			continue;
		}
		const close = html.indexOf('>', open);
		if (close === -1) {
			parts.push(sourceText(html.slice(open)));
			break;
		}
		const tag = html.slice(open, close + 1);
		at = close + 1;
		const [, slash = '', rawName = ''] = /^<(\/?)([a-z][a-z0-9]*)/i.exec(tag) ?? [];
		const name = rawName.toLowerCase();
		const closing = slash === '/';
		if (!closing && HIDDEN.includes(name)) {
			const end = indexOfTag(html, `</${name}`, at);
			const endClose = end === -1 ? -1 : html.indexOf('>', end);
			at = endClose === -1 ? html.length : endClose + 1;
			continue;
		}
		if (name === 'a' && !closing) {
			const href = /\shref\s*=\s*"([^"]*)"/i.exec(tag)?.[1];
			link = href === undefined ? null : {href, start: parts.length};
			continue;
		}
		if (name === 'a' && closing && link) {
			const label = parts.splice(link.start).join('').trim();
			parts.push(label === '' || label === link.href ? link.href : `${label} (${link.href})`);
			link = null;
			continue;
		}
		parts.push(tagText(name, closing));
	}
	return decodeEntities(parts.join(''))
		.replace(/[ \t\u00a0]+/g, ' ')
		.replace(/ ?\n ?/g, '\n')
		.replace(/\n{3,}/g, '\n\n')
		.trim();
}

// Text between tags: a line break in the HTML's source is a space, as a browser shows it.
function sourceText(text: string): string {
	return text.replace(/\r\n?|\n/g, ' ');
}

// Where a tag next starts from `from`, whatever its case. The email isn't lowercased whole to look,
// since a letter can lowercase to more than one, as İ does, which would move everything after it.
function indexOfTag(html: string, tag: string, from: number): number {
	const pattern = new RegExp(tag, 'ig');
	pattern.lastIndex = from;
	return pattern.exec(html)?.index ?? -1;
}

/** A message's HTML part, as its sender wrote it, or null for one without. */
export function messageHtml(payload: MessagePart | undefined): string | null {
	const html = payload ? findText(payload, 'text/html') : null;
	return html ? decodePart(html) : null;
}

/** A message's text: its plain text part, else its HTML part as text, then the names of its attachments. */
export function messageBody(payload: MessagePart | undefined): string {
	if (!payload) {
		return '';
	}
	const plain = findText(payload, 'text/plain');
	const html = plain ? null : findText(payload, 'text/html');
	const text = plain ? decodePart(plain).replace(/\r\n?/g, '\n').trim() : html ? htmlToText(decodePart(html)) : '';
	const attachments = attachmentNames(payload);
	if (attachments.length === 0) {
		return text;
	}
	return `${text}\n\nAttachments: ${attachments.join(', ')}`.trim();
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
