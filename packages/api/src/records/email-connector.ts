import {randomUUID} from 'node:crypto';

import {ImapFlow, type FetchMessageObject, type MailboxObject, type MessageAddressObject, type SearchObject} from 'imapflow';
import {simpleParser} from 'mailparser';
import MailComposer from 'nodemailer/lib/mail-composer';
import {Err, Ok, Result} from 'ts-results-es';
import {z} from 'zod';

import {ApiErr, type ApiError, Do, parseSchema, requirePresent} from '@proxy/utils';

import type {EmailCredential} from '../connections/email/credential';
import {imapClientOptions, imapError, smtpError, smtpTransport} from '../connections/email/mail-check';
import {log, serializeError} from '../observability/log';
import {decryptSecret} from '../utils/secret-crypto';
import type {Connector, DataRecord, ListQuery, RecordPage, RecordTarget, RecordValues} from './connector';

/**
 * A mailbox over IMAP, signed in fresh for every request. Emails are the inbox's messages, drafts
 * the messages in the mailbox's Drafts folder, each listed newest first, a page at a time. A record's id is the folder's UIDVALIDITY and
 * the message's UID, so an id from before the server renumbered the folder finds nothing.
 *
 * IMAP messages can't be changed, so updating a draft saves a new one and deletes the old: the
 * draft gets a new id. Creating in Sent sends the email.
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

type Session = {client: ImapFlow; mailbox: MailboxObject; credential: EmailCredential};

// The folder a collection reads: the inbox, or whichever folder the server marks as Drafts or Sent.
async function folderOf(client: ImapFlow, collectionId: string): Promise<Result<string, ApiError>> {
	if (collectionId === 'emails') {
		return Ok('INBOX');
	}

	const specialUse = collectionId === 'sent' ? '\\Sent' : '\\Drafts';
	const folders = await Result.wrapAsync(() => client.list());
	if (folders.isErr()) {
		return Err(ApiErr.providerUnreachable(folders.error));
	}
	const folder = folders.value.find((candidate) => candidate.specialUse === specialUse);
	return requirePresent(folder?.path, ApiErr.notFound('folder', specialUse));
}

/** Signs in, opens the collection's folder, runs `work`, and always signs out again. */
async function withFolder<T>(target: RecordTarget, work: (session: Session) => Promise<Result<T, ApiError>>): Promise<Result<T, ApiError>> {
	const credential = readCredential(target);
	if (credential.isErr()) {
		return credential;
	}

	const client = new ImapFlow(imapClientOptions(credential.value));
	client.on('error', (error: unknown) => log.warn('imap socket error', serializeError(error)));
	const connected = await Result.wrapAsync(() => client.connect());
	if (connected.isErr()) {
		client.close();
		return Err(imapError(connected.error));
	}

	const outcome = await Do<T, ApiError>(async ($) => {
		const path = $(await folderOf(client, target.collection.id));
		const lock = $((await Result.wrapAsync(() => client.getMailboxLock(path))).mapErr((cause) => ApiErr.providerUnreachable(cause)));
		const mailbox = client.mailbox;
		const result: Result<Result<T, ApiError>, unknown> = mailbox ? await Result.wrapAsync(() => work({client, mailbox, credential: credential.value})) : Err(new Error('No folder open'));
		lock.release();
		return $($(result.mapErr((cause) => ApiErr.providerUnreachable(cause))));
	});

	await Result.wrapAsync(() => client.logout());
	return outcome;
}

function recordId(mailbox: MailboxObject, uid: number): string {
	return `${mailbox.uidValidity}-${uid}`;
}

// A sent email Gmail hasn't filed yet has no UID to point at, so its id names its Message-ID.
const MESSAGE_ID_PREFIX = 'msg-';

function messageIdRecordId(messageId: string): string {
	return `${MESSAGE_ID_PREFIX}${Buffer.from(messageId).toString('base64url')}`;
}

async function findByMessageId(client: ImapFlow, messageId: string): Promise<number | undefined> {
	return ((await client.search({header: {'message-id': messageId}}, {uid: true})) || [])[0];
}

/** The UID a record id points at in the open folder, by UID or by Message-ID. */
async function resolveUid({client, mailbox}: Session, id: string): Promise<Result<number, ApiError>> {
	if (!id.startsWith(MESSAGE_ID_PREFIX)) {
		return uidOf(mailbox, id);
	}

	const messageId = Buffer.from(id.slice(MESSAGE_ID_PREFIX.length), 'base64url').toString();
	return requirePresent(await findByMessageId(client, messageId), ApiErr.notFound('record', id));
}

function uidOf(mailbox: MailboxObject, id: string): Result<number, ApiError> {
	const [uidValidity, uid] = id.split('-');
	if (uidValidity !== String(mailbox.uidValidity) || !uid || !/^\d+$/.test(uid)) {
		return Err(ApiErr.notFound('record', id));
	}
	return Ok(Number(uid));
}

// Received emails keep the sender's name; a draft's recipients are bare addresses, as they are typed.
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

function summaryValues(collectionId: string, message: FetchMessageObject): RecordValues {
	const envelope = message.envelope;
	if (collectionId === 'drafts') {
		return {to: formatAddresses(envelope?.to, false), subject: envelope?.subject ?? ''};
	}

	if (collectionId === 'sent') {
		const sentAt = envelope?.date ? new Date(envelope.date).toISOString() : '';
		return {to: formatAddresses(envelope?.to, false), subject: envelope?.subject ?? '', sentAt};
	}

	const receivedAt = message.internalDate ? new Date(message.internalDate).toISOString() : '';
	return {from: formatAddresses(envelope?.from, true), to: formatAddresses(envelope?.to, true), subject: envelope?.subject ?? '', receivedAt};
}

function updatedAt(message: FetchMessageObject): string {
	return message.internalDate ? new Date(message.internalDate).toISOString() : new Date(0).toISOString();
}

function toSummary(target: RecordTarget, mailbox: MailboxObject, message: FetchMessageObject): DataRecord {
	return {id: recordId(mailbox, message.uid), values: summaryValues(target.collection.id, message), updatedAt: updatedAt(message)};
}

// Gmail takes its own search syntax over IMAP (from:, has:attachment, newer_than:7d); any other
// server searches the headers and text for the words.
function searchCriteria(client: ImapFlow, search: string | null): SearchObject {
	if (!search) {
		return {all: true};
	}
	if (client.capabilities.has('X-GM-EXT-1')) {
		return {gmraw: search};
	}
	return {text: search};
}

/**
 * A page of the folder, newest first. The next page's token is the id of the oldest message on
 * this one, so paging goes on from there even as new mail arrives.
 */
async function listMessages(target: RecordTarget, {client, mailbox}: Session, query: ListQuery): Promise<Result<RecordPage, ApiError>> {
	return Do(async ($) => {
		const before = query.page ? $(uidOf(mailbox, query.page)) : null;
		const nextPage = (records: DataRecord[], more: boolean) => (more ? (records.at(-1)?.id ?? null) : null);

		// The common case, the newest messages: read by position, without a search.
		if (!query.search && before === null) {
			if (mailbox.exists === 0) {
				return {records: [], nextPage: null};
			}
			const range = `${Math.max(1, mailbox.exists - PAGE_SIZE + 1)}:*`;
			const messages = await client.fetchAll(range, {uid: true, envelope: true, internalDate: true});
			const records = messages.sort((a, b) => b.uid - a.uid).map((message) => toSummary(target, mailbox, message));
			return {records, nextPage: nextPage(records, mailbox.exists > PAGE_SIZE)};
		}

		if (before !== null && before <= 1) {
			return {records: [], nextPage: null};
		}

		const criteria = {...searchCriteria(client, query.search), ...(before === null ? {} : {uid: `1:${before - 1}`})};
		const found = ((await client.search(criteria, {uid: true})) || []).sort((a, b) => b - a);
		const uids = found.slice(0, PAGE_SIZE);
		if (uids.length === 0) {
			return {records: [], nextPage: null};
		}

		const messages = await client.fetchAll(uids.join(','), {uid: true, envelope: true, internalDate: true}, {uid: true});
		const records = messages.sort((a, b) => b.uid - a.uid).map((message) => toSummary(target, mailbox, message));
		return {records, nextPage: nextPage(records, found.length > PAGE_SIZE)};
	});
}

async function getMessage(target: RecordTarget, session: Session, id: string): Promise<Result<DataRecord, ApiError>> {
	return Do(async ($) => {
		const {client} = session;
		const uid = $(await resolveUid(session, id));
		const message = await client.fetchOne(String(uid), {uid: true, envelope: true, internalDate: true, source: true}, {uid: true});
		if (!message || !message.source) {
			return $(Err(ApiErr.notFound('record', id)));
		}

		const source = message.source;
		const parsed = $((await Result.wrapAsync(() => simpleParser(source))).mapErr((cause) => ApiErr.providerUnreachable(cause)));
		const body = (parsed.text ?? '').trim();
		return {id, values: {...summaryValues(target.collection.id, message), body}, updatedAt: updatedAt(message)};
	});
}

/** An email from the connected address, built from the typed-in values. */
function compose(credential: EmailCredential, values: RecordValues, messageId: string): Promise<Buffer> {
	return new MailComposer({from: credential.username, to: values.to, subject: values.subject, text: values.body, messageId}).compile().build();
}

/** Saves a draft from the typed-in values and reads it back. */
async function appendDraft(target: RecordTarget, session: Session, values: RecordValues): Promise<Result<DataRecord, ApiError>> {
	return Do(async ($) => {
		const {client, mailbox, credential} = session;
		const messageId = `<${randomUUID()}@proxy>`;
		const appended = await client.append(mailbox.path, await compose(credential, values, messageId), ['\\Draft', '\\Seen']);

		// Servers without UIDPLUS don't say which UID the draft got; its Message-ID finds it.
		const uid = appended && appended.uid ? appended.uid : await findByMessageId(client, messageId);
		if (uid === undefined) {
			return $(Err(ApiErr.providerUnreachable(new Error('The saved draft could not be found'))));
		}
		return $(await getMessage(target, session, recordId(mailbox, uid)));
	});
}

/**
 * Sends the email over SMTP and files a copy in Sent. Gmail files every email sent through it on
 * its own; anywhere else Personal Agent Proxy saves the copy, as a mail client does. Once the server has taken
 * the email it is gone, so nothing after that reports the send as failed: a copy that can't be
 * filed or found yet still answers with what was sent.
 */
async function sendEmail(target: RecordTarget, session: Session, values: RecordValues): Promise<Result<DataRecord, ApiError>> {
	return Do(async ($) => {
		const {client, mailbox, credential} = session;
		if (!values.to?.trim()) {
			return $(Err(ApiErr.validationError('An email needs a recipient')));
		}

		const messageId = `<${randomUUID()}@proxy>`;
		const raw = await compose(credential, values, messageId);
		const transport = smtpTransport(credential);
		const sent = await Result.wrapAsync(() => transport.sendMail({envelope: {from: credential.username, to: values.to}, raw}));
		transport.close();
		$(sent.mapErr(smtpError));

		const gmail = client.capabilities.has('X-GM-EXT-1');
		const filed = gmail ? undefined : await Result.wrapAsync(() => client.append(mailbox.path, raw, ['\\Seen']));
		const uid = filed?.isOk() && filed.value && filed.value.uid ? filed.value.uid : await findByMessageId(client, messageId);
		const id = uid === undefined ? messageIdRecordId(messageId) : recordId(mailbox, uid);
		const found = uid === undefined ? null : await getMessage(target, session, id);
		if (found?.isOk()) {
			return found.value;
		}
		return {id, values: {...values, sentAt: new Date().toISOString()}, updatedAt: new Date().toISOString()};
	});
}

async function deleteMessage(session: Session, id: string): Promise<Result<void, ApiError>> {
	return Do(async ($) => {
		const {client} = session;
		const uid = $(await resolveUid(session, id));
		const found = await client.fetchOne(String(uid), {uid: true}, {uid: true});
		if (!found) {
			return $(Err(ApiErr.notFound('record', id)));
		}
		await client.messageDelete(String(uid), {uid: true});
	});
}

export const emailConnector: Connector = {
	list: (target, query) => withFolder(target, (session) => listMessages(target, session, query)),
	get: (target, recordId) => withFolder(target, (session) => getMessage(target, session, recordId)),
	create: (target, values) => withFolder(target, (session) => (target.collection.id === 'sent' ? sendEmail(target, session, values) : appendDraft(target, session, values))),
	update: (target, recordId, values) =>
		withFolder(target, (session) =>
			Do(async ($) => {
				const uid = $(await resolveUid(session, recordId));
				if (!(await session.client.fetchOne(String(uid), {uid: true}, {uid: true}))) {
					return $(Err(ApiErr.notFound('record', recordId)));
				}
				const draft = $(await appendDraft(target, session, values));
				$(await deleteMessage(session, recordId));
				return draft;
			}),
		),
	remove: (target, recordId) => withFolder(target, (session) => deleteMessage(session, recordId)),
};
