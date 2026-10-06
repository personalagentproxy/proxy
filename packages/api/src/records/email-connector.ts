import {randomUUID} from 'node:crypto';

import {ImapFlow, type FetchMessageObject, type MailboxObject, type MessageAddressObject} from 'imapflow';
import {simpleParser} from 'mailparser';
import MailComposer from 'nodemailer/lib/mail-composer';
import {Err, Ok, Result} from 'ts-results-es';
import {z} from 'zod';

import {ApiErr, type ApiError, Do, parseSchema, requirePresent} from '@proxy/utils';

import type {EmailCredential} from '../connections/email/credential';
import {imapClientOptions, imapError} from '../connections/email/mail-check';
import {log, serializeError} from '../observability/log';
import {decryptSecret} from '../utils/secret-crypto';
import type {Connector, DataRecord, RecordTarget, RecordValues} from './connector';

/**
 * A mailbox over IMAP, signed in fresh for every request. Emails are the inbox's latest messages,
 * drafts the messages in the mailbox's Drafts folder. A record's id is the folder's UIDVALIDITY and
 * the message's UID, so an id from before the server renumbered the folder finds nothing.
 *
 * IMAP messages can't be changed, so updating a draft saves a new one and deletes the old: the
 * draft gets a new id.
 */

const LATEST = 50;

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

// The folder a collection reads: the inbox, or whichever folder the server marks as Drafts.
async function folderOf(client: ImapFlow, collectionId: string): Promise<Result<string, ApiError>> {
	if (collectionId === 'emails') {
		return Ok('INBOX');
	}

	const folders = await Result.wrapAsync(() => client.list());
	if (folders.isErr()) {
		return Err(ApiErr.providerUnreachable(folders.error));
	}
	const drafts = folders.value.find((folder) => folder.specialUse === '\\Drafts');
	return requirePresent(drafts?.path, ApiErr.notFound('folder', 'Drafts'));
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

	const receivedAt = message.internalDate ? new Date(message.internalDate).toISOString() : '';
	return {from: formatAddresses(envelope?.from, true), to: formatAddresses(envelope?.to, true), subject: envelope?.subject ?? '', receivedAt};
}

function updatedAt(message: FetchMessageObject): string {
	return message.internalDate ? new Date(message.internalDate).toISOString() : new Date(0).toISOString();
}

async function listMessages(target: RecordTarget, {client, mailbox}: Session): Promise<Result<DataRecord[], ApiError>> {
	if (mailbox.exists === 0) {
		return Ok([]);
	}

	const range = `${Math.max(1, mailbox.exists - LATEST + 1)}:*`;
	const messages = await client.fetchAll(range, {uid: true, envelope: true, internalDate: true});
	return Ok(messages.sort((a, b) => b.uid - a.uid).map((message) => ({id: recordId(mailbox, message.uid), values: summaryValues(target.collection.id, message), updatedAt: updatedAt(message)})));
}

async function getMessage(target: RecordTarget, {client, mailbox}: Session, id: string): Promise<Result<DataRecord, ApiError>> {
	return Do(async ($) => {
		const uid = $(uidOf(mailbox, id));
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

/** Saves a draft from the typed-in values, from the connected address, and reads it back. */
async function appendDraft(target: RecordTarget, session: Session, values: RecordValues): Promise<Result<DataRecord, ApiError>> {
	return Do(async ($) => {
		const {client, mailbox, credential} = session;
		const messageId = `<${randomUUID()}@proxy>`;
		const raw = await new MailComposer({from: credential.username, to: values.to, subject: values.subject, text: values.body, messageId}).compile().build();
		const appended = await client.append(mailbox.path, raw, ['\\Draft', '\\Seen']);

		// Servers without UIDPLUS don't say which UID the draft got; its Message-ID finds it.
		const uid = appended && appended.uid ? appended.uid : ((await client.search({header: {'message-id': messageId}}, {uid: true})) || [])[0];
		if (uid === undefined) {
			return $(Err(ApiErr.providerUnreachable(new Error('The saved draft could not be found'))));
		}
		return $(await getMessage(target, session, recordId(mailbox, uid)));
	});
}

async function deleteMessage({client, mailbox}: Session, id: string): Promise<Result<void, ApiError>> {
	return Do(async ($) => {
		const uid = $(uidOf(mailbox, id));
		const found = await client.fetchOne(String(uid), {uid: true}, {uid: true});
		if (!found) {
			return $(Err(ApiErr.notFound('record', id)));
		}
		await client.messageDelete(String(uid), {uid: true});
	});
}

export const emailConnector: Connector = {
	list: (target) => withFolder(target, (session) => listMessages(target, session)),
	get: (target, recordId) => withFolder(target, (session) => getMessage(target, session, recordId)),
	create: (target, values) => withFolder(target, (session) => appendDraft(target, session, values)),
	update: (target, recordId, values) =>
		withFolder(target, (session) =>
			Do(async ($) => {
				const uid = $(uidOf(session.mailbox, recordId));
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
