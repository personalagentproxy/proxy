import {randomUUID} from 'node:crypto';

import {ImapFlow, type FetchMessageObject, type MailboxObject, type MessageAddressObject, type SearchObject} from 'imapflow';
import {simpleParser, type AddressObject, type ParsedMail} from 'mailparser';
import MailComposer from 'nodemailer/lib/mail-composer';
import type Mail from 'nodemailer/lib/mailer';
import {Err, Ok, Result} from 'ts-results-es';
import {z} from 'zod';

import {ApiErr, type ApiError, Do, parseSchema, requirePresent} from '@proxy/utils';

import type {EmailCredential} from '../connections/email/credential';
import {imapClientOptions, imapError, smtpError, smtpTransport} from '../connections/email/mail-check';
import {log, serializeError} from '../observability/log';
import {decryptSecret} from '../utils/secret-crypto';
import {attachmentRecord, attachmentsText, pickAttachment, requireEmailId, type AttachmentFile} from './attachment-text';
import type {CommandRunner, DataRecord, ListQuery, RecordPage, RecordStore, RecordTarget, RecordValues, RunOnly} from './connector';
import {gmailQuery, type EmailSearch, type MailSearch} from './email-search';
import {replyCommands, replyHeaders, type MailReply, type ReplyHeaders} from './email-reply';

/**
 * A mailbox over IMAP, signed in fresh for every request. Its one list is the inbox and the
 * folders the server marks as Drafts and Sent, newest first, each email saying which it is in,
 * 50 to a page, narrowed to one folder or a search when asked. A record's id is the folder, the
 * folder's UIDVALIDITY and the message's UID, so an id from before the server renumbered the
 * folder finds nothing.
 *
 * IMAP messages can't be changed, so updating a draft saves a new one and deletes the old: the
 * draft gets a new id. Received emails are only flagged or moved: archived, or moved to Trash.
 * Email goes out over SMTP, from a draft or straight from values typed in. An email's attachments
 * are read from the message whole, as the `attachments` collection's one command. A reply, the
 * `replies` collection's, is written in the thread of the email it answers, sent or saved in Drafts.
 */

const PAGE_SIZE = 50;

const credentialSchema = z.object({
	imapHost: z.string(),
	smtpHost: z.string(),
	smtpPort: z.union([z.literal(465), z.literal(587)]),
	username: z.string(),
	password: z.string(),
});

function readCredential(target: RecordTarget): Result<EmailCredential, ApiError> {
	return Do<EmailCredential, ApiError>(($) => {
		const stored = $(requirePresent(target.connection.credential, ApiErr.internalError(new Error('Email connection without a credential'))));
		const json = $(decryptSecret(stored));
		const parsed = $(Result.wrap((): unknown => JSON.parse(json)).mapErr((cause) => ApiErr.internalError(cause)));
		return $(parseSchema(credentialSchema, parsed));
	});
}

type SpecialUse = '\\Drafts' | '\\Sent' | '\\Trash' | '\\Archive' | '\\All';

// The folders the list is made of; `label` is the record's folder field.
type Folder = {key: 'inbox' | 'drafts' | 'sent'; label: 'Inbox' | 'Draft' | 'Sent'};

const INBOX: Folder = {key: 'inbox', label: 'Inbox'};
const DRAFTS: Folder = {key: 'drafts', label: 'Draft'};
const SENT: Folder = {key: 'sent', label: 'Sent'};
const FOLDERS = [INBOX, DRAFTS, SENT];

type Session = {client: ImapFlow; mailbox: MailboxObject; credential: EmailCredential; folder: Folder};

// The folder the server marks for the first of `uses` it has, such as Trash. Gmail has no Archive
// but All Mail, where an email moved out of the inbox goes.
async function specialFolder(client: ImapFlow, uses: SpecialUse[], name: string): Promise<Result<string, ApiError>> {
	const folders = await Result.wrapAsync(() => client.list());
	if (folders.isErr()) {
		return Err(ApiErr.providerUnreachable(folders.error));
	}
	for (const use of uses) {
		const folder = folders.value.find((candidate) => candidate.specialUse === use);
		if (folder) {
			return Ok(folder.path);
		}
	}
	return Err(ApiErr.notFound('folder', name));
}

async function pathOf(client: ImapFlow, folder: Folder): Promise<Result<string, ApiError>> {
	if (folder === DRAFTS) {
		return specialFolder(client, ['\\Drafts'], 'Drafts');
	}
	if (folder === SENT) {
		return specialFolder(client, ['\\Sent'], 'Sent');
	}
	return Ok('INBOX');
}

/**
 * Signs in, runs `work`, and always signs out again; once `signal` says the work was given up on,
 * the connection is closed there and then, rather than left open until the work is done.
 */
async function withClient<T>(target: RecordTarget, work: (client: ImapFlow, credential: EmailCredential) => Promise<Result<T, ApiError>>, signal?: AbortSignal): Promise<Result<T, ApiError>> {
	const credential = readCredential(target);
	if (credential.isErr()) {
		return credential;
	}

	const client = new ImapFlow(imapClientOptions(credential.value));
	client.on('error', (error: unknown) => log.warn('imap socket error', serializeError(error)));
	const close = () => client.close();
	signal?.addEventListener('abort', close, {once: true});
	const connected = await Result.wrapAsync(() => client.connect());
	if (connected.isErr()) {
		signal?.removeEventListener('abort', close);
		client.close();
		return Err(imapError(connected.error));
	}

	const outcome = (await Result.wrapAsync(() => work(client, credential.value))).mapErr((cause) => ApiErr.providerUnreachable(cause)).andThen((result) => result);
	signal?.removeEventListener('abort', close);
	if (signal?.aborted) {
		return outcome;
	}
	await Result.wrapAsync(() => client.logout());
	return outcome;
}

/** Opens a folder for `work` on a signed-in client, and releases it after. */
async function inFolder<T>(client: ImapFlow, credential: EmailCredential, folder: Folder, work: (session: Session) => Promise<Result<T, ApiError>>): Promise<Result<T, ApiError>> {
	return Do(async ($) => {
		const path = $(await pathOf(client, folder));
		const lock = $((await Result.wrapAsync(() => client.getMailboxLock(path))).mapErr((cause) => ApiErr.providerUnreachable(cause)));
		const mailbox = client.mailbox;
		const result: Result<Result<T, ApiError>, unknown> = mailbox ? await Result.wrapAsync(() => work({client, mailbox, credential, folder})) : Err(new Error('No folder open'));
		lock.release();
		return $($(result.mapErr((cause) => ApiErr.providerUnreachable(cause))));
	});
}

function withFolder<T>(target: RecordTarget, folder: Folder, work: (session: Session) => Promise<Result<T, ApiError>>, signal?: AbortSignal): Promise<Result<T, ApiError>> {
	return withClient(target, (client, credential) => inFolder(client, credential, folder, work), signal);
}

function recordId(session: Session, uid: number): string {
	return `${session.folder.key}-${session.mailbox.uidValidity}-${uid}`;
}

// The folder an id names, before anything is opened.
function folderOf(id: string): Result<Folder, ApiError> {
	const folder = FOLDERS.find((candidate) => id.startsWith(`${candidate.key}-`));
	return requirePresent(folder, ApiErr.notFound('record', id));
}

function uidOf(session: Session, id: string): Result<number, ApiError> {
	const [key, uidValidity, uid] = id.split('-');
	if (key !== session.folder.key || uidValidity !== String(session.mailbox.uidValidity) || !uid || !/^\d+$/.test(uid)) {
		return Err(ApiErr.notFound('record', id));
	}
	return Ok(Number(uid));
}

/** Opens the folder a record's id names for `work`. */
function withRecord<T>(target: RecordTarget, id: string, work: (session: Session) => Promise<Result<T, ApiError>>): Promise<Result<T, ApiError>> {
	return Do(async ($) => $(await withFolder(target, $(folderOf(id)), work)));
}

// Received emails keep the sender's name; a draft's addresses are bare, as they are typed.
function formatAddresses(addresses: MessageAddressObject[] | undefined, withNames: boolean): string {
	return (addresses ?? [])
		.map(({name, address}) => {
			if (withNames && name && address) {
				return `${name} <${address}>`;
			}
			return address ?? name ?? '';
		})
		.filter(Boolean)
		.join(', ');
}

// "Unread, Flagged", for an email in the inbox.
function status(folder: Folder, flags: Set<string> | undefined): string {
	if (folder !== INBOX) {
		return '';
	}
	const seen = flags?.has('\\Seen') ? 'Read' : 'Unread';
	if (flags?.has('\\Flagged')) {
		return `${seen}, Flagged`;
	}
	return seen;
}

function updatedAt(message: FetchMessageObject): string {
	return message.internalDate ? new Date(message.internalDate).toISOString() : new Date(0).toISOString();
}

function summaryValues(folder: Folder, message: FetchMessageObject): RecordValues {
	const envelope = message.envelope;
	const withNames = folder !== DRAFTS;
	return {
		folder: folder.label,
		from: formatAddresses(envelope?.from, withNames),
		to: formatAddresses(envelope?.to, withNames),
		subject: envelope?.subject ?? '',
		date: message.internalDate ? updatedAt(message) : '',
		status: status(folder, message.flags),
	};
}

function toRecord(session: Session, message: FetchMessageObject): DataRecord {
	return {id: recordId(session, message.uid), values: summaryValues(session.folder, message), updatedAt: updatedAt(message)};
}

function isGmail(client: ImapFlow): boolean {
	return client.capabilities.has('X-GM-EXT-1');
}

// Gmail takes its own search syntax over IMAP (from:, has:attachment, newer_than:7d); any other
// server searches the headers and text for the words.
function searchCriteria(client: ImapFlow, search: string | null): SearchObject {
	if (!search) {
		return {all: true};
	}
	if (isGmail(client)) {
		return {gmraw: search};
	}
	return {text: search};
}

// What a list reads of each message.
const SUMMARY_FIELDS = {uid: true, envelope: true, internalDate: true, flags: true};

/** A folder's newest messages below the UID `before`, matching the search, and whether it has more. */
async function folderPage(session: Session, search: string | null, before: number | null): Promise<{messages: FetchMessageObject[]; more: boolean}> {
	const {client, mailbox} = session;

	// The common case, the newest messages: read by position, without a search.
	if (!search && before === null) {
		if (mailbox.exists === 0) {
			return {messages: [], more: false};
		}
		const range = `${Math.max(1, mailbox.exists - PAGE_SIZE + 1)}:*`;
		return {messages: await client.fetchAll(range, SUMMARY_FIELDS), more: mailbox.exists > PAGE_SIZE};
	}

	if (before !== null && before <= 1) {
		return {messages: [], more: false};
	}
	const criteria = {...searchCriteria(client, search), ...(before === null ? {} : {uid: `1:${before - 1}`})};
	const found = ((await client.search(criteria, {uid: true})) || []).sort((a, b) => b - a);
	const uids = found.slice(0, PAGE_SIZE);
	if (uids.length === 0) {
		return {messages: [], more: false};
	}
	return {messages: await client.fetchAll(uids.join(','), SUMMARY_FIELDS, {uid: true}), more: found.length > PAGE_SIZE};
}

// Any one of `conditions`.
function anyOf(conditions: SearchObject[]): SearchObject {
	return conditions.length === 1 && conditions[0] ? conditions[0] : {or: conditions};
}

// Every one of `conditions`. IMAP ANDs the keys of one object, so conditions that would share a key,
// as two ORs do, go together as NOT NOT (…), which IMAP reads as the condition itself.
function allOf(conditions: SearchObject[]): SearchObject {
	const [first, ...rest] = conditions;
	if (!first) {
		return {all: true};
	}
	if (rest.length === 0) {
		return first;
	}
	return {...first, not: {not: allOf(rest)}};
}

// A home page search in IMAP's own terms: from the sender, from, to or copied to someone, any of
// each term's words anywhere in the email, received since the day.
function imapCriteria(search: EmailSearch): SearchObject {
	const {involving} = search;
	return allOf([
		...(search.from ? [{from: search.from}] : []),
		...(involving ? [anyOf([{from: involving}, {to: involving}, {cc: involving}])] : []),
		...search.words.filter((term) => term.length > 0).map((term) => anyOf(term.map((word) => ({text: word})))),
		...(search.since ? [{since: search.since}] : []),
	]);
}

// A record found for the home page's widgets, with who was copied, which they find people in.
function withCc(record: DataRecord, message: FetchMessageObject): DataRecord {
	return {...record, values: {...record.values, cc: formatAddresses(message.envelope?.cc, true)}};
}

// A home page search in the server's terms: Gmail's own syntax where it takes it, else IMAP's.
// Gmail is asked for every email by an empty search, which X-GM-RAW won't take.
function findCriteria(client: ImapFlow, search: EmailSearch): SearchObject {
	const query = isGmail(client) ? gmailQuery(search) : '';
	if (query !== '') {
		return {gmraw: query};
	}
	return imapCriteria(search);
}

// The newest emails in the open inbox one search finds, at most `limit`.
async function findInSession(session: Session, search: EmailSearch, limit: number): Promise<DataRecord[]> {
	const {client} = session;
	const criteria = findCriteria(client, search);
	const uids = ((await client.search(criteria, {uid: true})) || []).sort((a, b) => b - a).slice(0, limit);
	if (uids.length === 0) {
		return [];
	}
	const messages = await client.fetchAll(uids.join(','), SUMMARY_FIELDS, {uid: true});
	return messages.sort((a, b) => b.uid - a.uid).map((message) => withCc(toRecord(session, message), message));
}

// A search only for someone the email is from, to or copied to, which the envelope alone tells.
function onlyInvolving(search: EmailSearch): search is EmailSearch & {involving: string} {
	return Boolean(search.involving) && !search.from && search.words.length === 0 && !search.since;
}

// Whether the email is from, to or copied to someone, as IMAP's FROM, TO and CC match: the words
// anywhere in the header, its names or addresses, whatever their case.
function involves(message: FetchMessageObject, someone: string): boolean {
	const {envelope} = message;
	const wanted = someone.toLowerCase();
	return [...(envelope?.from ?? []), ...(envelope?.to ?? []), ...(envelope?.cc ?? [])].some(({name, address}) => `${name ?? ''} <${address ?? ''}>`.toLowerCase().includes(wanted));
}

/**
 * The newest emails each of `searches`, each only for someone, finds, at most `limit` each, from
 * one IMAP search for any of them: the newest of their emails, as many as all of them could want,
 * each going to everyone it involves. Someone those leave short, behind someone written to more,
 * is searched for on their own, so each still gets their own newest.
 */
async function findEveryone(session: Session, searches: Array<EmailSearch & {involving: string}>, limit: number): Promise<DataRecord[][]> {
	const {client} = session;
	const criteria: SearchObject = {or: searches.flatMap(({involving}) => [{from: involving}, {to: involving}, {cc: involving}])};
	const uids = ((await client.search(criteria, {uid: true})) || []).sort((a, b) => b - a);
	const newest = uids.slice(0, limit * searches.length);
	const messages = newest.length === 0 ? [] : (await client.fetchAll(newest.join(','), SUMMARY_FIELDS, {uid: true})).sort((a, b) => b.uid - a.uid);
	const found: DataRecord[][] = [];
	for (const search of searches) {
		const theirs = messages.filter((message) => involves(message, search.involving)).slice(0, limit);
		const short = theirs.length < limit && uids.length > newest.length;
		found.push(short ? await findInSession(session, search, limit) : theirs.map((message) => withCc(toRecord(session, message), message)));
	}
	return found;
}

/**
 * The newest emails in the inbox each home page search finds, at most `limit` each: in Gmail's
 * syntax on Gmail, else in IMAP's own terms. One sign-in runs them all, as servers allow an
 * account only so many connections at once: searches only for people, as the People widget's,
 * as one search for any of them where it can, any others one after the other.
 */
const findInboxEmails: MailSearch = (target, searches, limit, signal) =>
	withFolder(
		target,
		INBOX,
		async (session) => {
			const people = searches.filter(onlyInvolving);
			if (searches.length > 1 && people.length === searches.length) {
				return Ok(await findEveryone(session, people, limit));
			}
			const found: DataRecord[][] = [];
			for (const search of searches) {
				found.push(await findInSession(session, search, limit));
			}
			return Ok(found);
		},
		signal,
	);

// Where each folder goes on, in a page token: the folder, its UIDVALIDITY, and the UID listing
// continues below, as `inbox-7-120,sent-7-33`. A folder left out has nothing more to list.
type Cursor = {folder: Folder; uidValidity: string; before: number};

function parseCursors(token: string): Result<Cursor[], ApiError> {
	const cursors: Cursor[] = [];
	for (const part of token.split(',')) {
		const [key, uidValidity, before] = part.split('-');
		const folder = FOLDERS.find((candidate) => candidate.key === key);
		if (!folder || !uidValidity || !before || !/^\d+$/.test(before)) {
			return Err(ApiErr.validationError('Not a page of this list'));
		}
		cursors.push({folder, uidValidity, before: Number(before)});
	}
	return Ok(cursors);
}

type FolderPage = {folder: Folder; uidValidity: string; uidNext: number; before: number | null; records: Array<DataRecord & {uid: number}>; more: boolean};

/**
 * The folders' records newest first, up to a page, taking each folder's in UID order so that
 * where it stops is a cursor; and how many it took of each.
 */
function mergeNewest(pages: FolderPage[]): {shown: DataRecord[]; taken: number[]} {
	const taken = pages.map(() => 0);
	const shown: DataRecord[] = [];
	while (shown.length < PAGE_SIZE) {
		const heads = pages.map((page, index) => page.records[taken[index] ?? 0]);
		const next = heads.reduce((best, head, index) => {
			const current = heads[best];
			if (!head || (current && current.updatedAt >= head.updatedAt)) {
				return best;
			}
			return index;
		}, 0);
		const record = heads[next];
		if (!record) {
			break;
		}
		shown.push({id: record.id, values: record.values, updatedAt: record.updatedAt});
		taken[next] = (taken[next] ?? 0) + 1;
	}
	return {shown, taken};
}

/**
 * A page of the list, newest first. Each folder in it gives up to a page of its newest messages
 * past its cursor; they are merged by date, each folder's in UID order so none is skipped, and cut
 * to a page. A folder goes on from its oldest message shown, or from where it was if none showed.
 * A server without a Drafts or Sent folder lists the rest.
 */
function listPage(target: RecordTarget, query: ListQuery): Promise<Result<RecordPage, ApiError>> {
	return withClient(target, (client, credential) =>
		Do(async ($) => {
			const scope = FOLDERS.filter((folder) => !query.filter || folder.label === query.filter);
			const cursors = query.page ? $(parseCursors(query.page)) : null;
			const pages: FolderPage[] = [];
			for (const folder of scope) {
				const cursor = cursors?.find((candidate) => candidate.folder === folder);
				if (cursors && !cursor) {
					continue;
				}
				const listed = await inFolder<FolderPage>(client, credential, folder, (session) =>
					Do(async ($$) => {
						const uidValidity = String(session.mailbox.uidValidity);
						if (cursor && cursor.uidValidity !== uidValidity) {
							return $$(Err(ApiErr.validationError('The mailbox changed; list it again from the start')));
						}
						const before = cursor?.before ?? null;
						const {messages, more} = await folderPage(session, query.search, before);
						const records = messages.sort((a, b) => b.uid - a.uid).map((message) => ({...toRecord(session, message), uid: message.uid}));
						return {folder, uidValidity, uidNext: session.mailbox.uidNext, before, records, more};
					}),
				);
				if (listed.isErr() && listed.error.kind === 'not_found' && listed.error.resource === 'folder') {
					continue;
				}
				pages.push($(listed));
			}

			const {shown, taken} = mergeNewest(pages);
			const tokens = pages.flatMap((page, index) => {
				const used = taken[index] ?? 0;
				if (used === page.records.length && !page.more) {
					return [];
				}
				const oldestShown = page.records[used - 1]?.uid;
				return [`${page.folder.key}-${page.uidValidity}-${oldestShown ?? page.before ?? page.uidNext}`];
			});
			return {records: shown, nextPage: tokens.length > 0 ? tokens.join(',') : null};
		}),
	);
}

// A message whole, as it was fetched and as mailparser reads it.
async function parsedMessage(session: Session, id: string): Promise<Result<{message: FetchMessageObject; parsed: ParsedMail}, ApiError>> {
	return Do(async ($) => {
		const uid = $(uidOf(session, id));
		const message = await session.client.fetchOne(String(uid), {uid: true, envelope: true, internalDate: true, flags: true, source: true}, {uid: true});
		if (!message || !message.source) {
			return $(Err(ApiErr.notFound('record', id)));
		}

		const source = message.source;
		const parsed = $((await Result.wrapAsync(() => simpleParser(source))).mapErr((cause) => ApiErr.providerUnreachable(cause)));
		return {message, parsed};
	});
}

function attachmentFiles(parsed: ParsedMail): AttachmentFile[] {
	return parsed.attachments.map((attachment) => ({name: attachment.filename ?? '', type: attachment.contentType, size: attachment.size, bytes: attachment.content}));
}

async function getMessage(session: Session, id: string): Promise<Result<DataRecord, ApiError>> {
	return Do(async ($) => {
		const {message, parsed} = $(await parsedMessage(session, id));
		const body = (parsed.text ?? '').trim();
		const values = {...summaryValues(session.folder, message), body, attachments: attachmentsText(attachmentFiles(parsed)), messageId: parsed.messageId ?? ''};
		return {id, values, updatedAt: updatedAt(message)};
	});
}

/** One of an email's attachments, read as text: the `attachments` collection's one command. */
function readAttachment(target: RecordTarget, values: RecordValues): Promise<Result<DataRecord, ApiError>> {
	return Do(async ($) => {
		const email = $(requireEmailId(values));
		return $(
			await withRecord(target, email, (session) =>
				Do(async ($$) => {
					const {parsed} = $$(await parsedMessage(session, email));
					const {attachment, number} = $$(pickAttachment(attachmentFiles(parsed), values));
					return $$(await attachmentRecord(email, number, attachment));
				}),
			),
		);
	});
}

// The headers that keep a reply in the thread of the email it answers.
type Thread = Pick<ReplyHeaders, 'inReplyTo' | 'references'>;

function threadOptions(thread: Thread | null): Mail.Options {
	return thread ? {inReplyTo: thread.inReplyTo, references: thread.references} : {};
}

// Who else an email goes to, as a reply to all copies whom the email it answers copied.
function ccOptions(values: RecordValues): Mail.Options {
	return values.cc ? {cc: values.cc} : {};
}

/** Saves a draft from the typed-in values, from the connected address, a reply in `thread`: its UID. */
async function saveDraft(session: Session, values: RecordValues, thread: Thread | null): Promise<Result<number, ApiError>> {
	return Do(async ($) => {
		const {client, mailbox, credential} = session;
		const messageId = `<${randomUUID()}@proxy>`;
		const raw = await new MailComposer({from: credential.username, to: values.to, ...ccOptions(values), subject: values.subject, text: values.body, messageId, ...threadOptions(thread)})
			.compile()
			.build();
		const appended = await client.append(mailbox.path, raw, ['\\Draft', '\\Seen']);

		// Servers without UIDPLUS don't say which UID the draft got; its Message-ID finds it.
		const uid = appended && appended.uid ? appended.uid : ((await client.search({header: {'message-id': messageId}}, {uid: true})) || [])[0];
		if (uid === undefined) {
			return $(
				Err(
					ApiErr.providerUnreachable(
						new Error('The saved draft could not be found'),
						'The draft was saved, but the mailbox didn’t say which it is: look for it in the drafts before saving it again, so it isn’t saved twice.',
					),
				),
			);
		}
		return uid;
	});
}

/** Saves a draft from the typed-in values, from the connected address, and reads it back. */
async function appendDraft(session: Session, values: RecordValues): Promise<Result<DataRecord, ApiError>> {
	return Do(async ($) => {
		const uid = $(await saveDraft(session, values, null));
		return $(await getMessage(session, recordId(session, uid)));
	});
}

/** The UID of the message the id names in the open folder, once the server confirms it is there. */
async function requireMessage(session: Session, id: string): Promise<Result<number, ApiError>> {
	return Do(async ($) => {
		const uid = $(uidOf(session, id));
		if (!(await session.client.fetchOne(String(uid), {uid: true}, {uid: true}))) {
			return $(Err(ApiErr.notFound('record', id)));
		}
		return uid;
	});
}

async function deleteMessage(session: Session, id: string): Promise<Result<void, ApiError>> {
	return Do(async ($) => {
		const uid = $(await requireMessage(session, id));
		await session.client.messageDelete(String(uid), {uid: true});
	});
}

// Only drafts can be edited or deleted; the routes check too.
function requireDraft(id: string): Result<Folder, ApiError> {
	return folderOf(id).andThen((folder) => (folder === DRAFTS ? Ok(folder) : Err(ApiErr.validationError('Only drafts can be edited or deleted'))));
}

// Marks or unmarks an email, such as read or flagged, and reads it back.
function setFlag(flag: '\\Seen' | '\\Flagged', on: boolean): CommandRunner {
	return (target, id) =>
		withRecord(target, id, (session) =>
			Do(async ($) => {
				const uid = String($(await requireMessage(session, id)));
				if (on) {
					await session.client.messageFlagsAdd(uid, [flag], {uid: true});
				}
				if (!on) {
					await session.client.messageFlagsRemove(uid, [flag], {uid: true});
				}
				return $(await getMessage(session, id));
			}),
		);
}

// Moves an email to the folder the server marks for one of `uses`; it leaves the list.
function moveTo(uses: SpecialUse[], name: string): CommandRunner {
	return (target, id) =>
		withRecord(target, id, (session) =>
			Do(async ($) => {
				const uid = $(await requireMessage(session, id));
				const path = $(await specialFolder(session.client, uses, name));
				await session.client.messageMove(String(uid), path, {uid: true});
				return null;
			}),
		);
}

/**
 * Sends an email from the connected address, a reply in `thread`, then files a copy in Sent (Gmail
 * does that itself): its Message-ID. Once the email is out, a copy left unfiled is only logged: a
 * failure then would invite the agent to send it twice.
 */
async function deliver(client: ImapFlow, credential: EmailCredential, values: RecordValues, thread: Thread | null = null): Promise<Result<string, ApiError>> {
	return Do(async ($) => {
		const to = values.to?.trim() ?? '';
		if (to === '') {
			return $(Err(ApiErr.validationError('The email has no recipient')));
		}

		const messageId = `<${randomUUID()}@proxy>`;
		const message: Mail.Options = {from: credential.username, to, ...ccOptions(values), subject: values.subject ?? '', text: values.body ?? '', messageId, ...threadOptions(thread)};
		const transport = smtpTransport(credential);
		const sent = await Result.wrapAsync(() => transport.sendMail(message));
		transport.close();
		$(sent.mapErr(smtpError));

		if (isGmail(client)) {
			return messageId;
		}
		const filed = await Do<void, ApiError>(async ($$) => {
			const path = $$(await specialFolder(client, ['\\Sent'], 'Sent'));
			const raw = await new MailComposer(message).compile().build();
			$$((await Result.wrapAsync(() => client.append(path, raw, ['\\Seen']))).mapErr((cause) => ApiErr.providerUnreachable(cause)));
		});
		if (filed.isErr()) {
			log.warn('sent email not filed in Sent', serializeError(filed.error));
		}
		return messageId;
	});
}

// Sends a draft and deletes it; a draft left behind once sent is only logged, as in `deliver`.
async function sendDraft(session: Session, id: string): Promise<Result<null, ApiError>> {
	return Do(async ($) => {
		const uid = $(uidOf(session, id));
		const draft = $(await getMessage(session, id));
		$(await deliver(session.client, session.credential, draft.values));

		const removed = await Result.wrapAsync(() => session.client.messageDelete(String(uid), {uid: true}));
		if (removed.isErr()) {
			log.warn('sent draft not deleted', serializeError(removed.error));
		}
		return null;
	});
}

// An email's To or Cc, as mailparser reads it: one list, several, or none.
function addressesText(addresses: AddressObject | AddressObject[] | undefined): string {
	return [addresses ?? []]
		.flat()
		.map((one) => one.text)
		.join(', ');
}

// An email's References, as mailparser reads them: one id, several, or none.
function referencesOf(references: string | string[] | undefined): string {
	return [references ?? []].flat().join(' ');
}

// The headers of a reply to the email in the open folder, from its own headers, to all where `all`.
async function replyTo(session: Session, id: string, all: boolean): Promise<Result<ReplyHeaders, ApiError>> {
	return Do(async ($) => {
		const uid = $(uidOf(session, id));
		const message = await session.client.fetchOne(String(uid), {uid: true, source: true}, {uid: true});
		if (!message || !message.source) {
			return $(Err(ApiErr.notFound('record', id)));
		}
		const source = message.source;
		const parsed = $((await Result.wrapAsync(() => simpleParser(source))).mapErr((cause) => ApiErr.providerUnreachable(cause)));
		return replyHeaders(
			session.credential.username,
			{
				from: parsed.from?.text ?? '',
				replyTo: parsed.replyTo?.text ?? '',
				to: addressesText(parsed.to),
				cc: addressesText(parsed.cc),
				subject: parsed.subject ?? '',
				messageId: parsed.messageId ?? '',
				references: referencesOf(parsed.references),
			},
			all,
		);
	});
}

/**
 * A reply to an email in the inbox or sent mail, from the connected address, in the email's
 * thread: sent over SMTP, or saved in Drafts. The email's folder is let go of before Drafts is
 * opened. A draft isn't replied to.
 */
const replyToMailbox: MailReply = (target, id, reply) =>
	withClient(target, (client, credential) =>
		Do(async ($) => {
			const folder = $(folderOf(id));
			if (folder === DRAFTS) {
				return $(Err(ApiErr.validationError('A draft isn’t replied to: send it, or reply to the email it answers')));
			}
			const headers = $(await inFolder(client, credential, folder, (session) => replyTo(session, id, reply.all)));
			const values = {to: headers.to, cc: headers.cc, subject: headers.subject, body: reply.body};
			if (reply.send) {
				const messageId = $(await deliver(client, credential, values, headers));
				return {...headers, id: messageId, thread: ''};
			}
			const draft = $(await inFolder(client, credential, DRAFTS, async (session) => (await saveDraft(session, values, headers)).map((uid) => recordId(session, uid))));
			return {...headers, id: draft, thread: ''};
		}),
	);

export const emailConnector = {
	list: listPage,
	get: (target, id) => withRecord(target, id, (session) => getMessage(session, id)),
	create: (target, values) => withFolder(target, DRAFTS, (session) => appendDraft(session, values)),
	update: (target, id, values) =>
		Do(async ($) =>
			$(
				await withFolder(target, $(requireDraft(id)), (session) =>
					Do(async ($$) => {
						$$(await requireMessage(session, id));
						const draft = $$(await appendDraft(session, values));
						$$(await deleteMessage(session, id));
						return draft;
					}),
				),
			),
		),
	remove: (target, id) => Do(async ($) => $(await withFolder(target, $(requireDraft(id)), (session) => deleteMessage(session, id)))),
	commands: {
		markRead: setFlag('\\Seen', true),
		markUnread: setFlag('\\Seen', false),
		flag: setFlag('\\Flagged', true),
		unflag: setFlag('\\Flagged', false),
		archive: moveTo(['\\Archive', '\\All'], 'Archive'),
		trash: moveTo(['\\Trash'], 'Trash'),
		send: (target, id) => withRecord(target, id, (session) => sendDraft(session, id)),
	},
	newCommands: {
		sendNew: (target, values) => withClient(target, async (client, credential) => (await deliver(client, credential, values)).map(() => null)),
	},
	findEmails: findInboxEmails,
	reply: replyToMailbox,
} satisfies RecordStore;

export const emailAttachmentsConnector = {newCommands: {read: readAttachment}} satisfies RunOnly;

// Send and Save as draft.
export const emailRepliesConnector = {newCommands: replyCommands(replyToMailbox)} satisfies RunOnly;
