import {randomUUID} from 'node:crypto';

import {ImapFlow, type FetchMessageObject, type MailboxObject, type MessageAddressObject} from 'imapflow';
import {simpleParser} from 'mailparser';
import MailComposer from 'nodemailer/lib/mail-composer';
import type Mail from 'nodemailer/lib/mailer';
import {Err, Ok, Result} from 'ts-results-es';
import {z} from 'zod';

import {ApiErr, type ApiError, Do, parseSchema, requirePresent} from '@proxy/utils';

import type {EmailCredential} from '../connections/email/credential';
import {imapClientOptions, imapError, smtpError, smtpTransport} from '../connections/email/mail-check';
import {log, serializeError} from '../observability/log';
import {decryptSecret} from '../utils/secret-crypto';
import type {CommandRunner, Connector, DataRecord, RecordTarget, RecordValues} from './connector';

/**
 * A mailbox over IMAP, signed in fresh for every request. Emails are the inbox's latest messages,
 * drafts and sent the messages in the folders the server marks as Drafts and Sent. A record's id is
 * the folder's UIDVALIDITY and the message's UID, so an id from before the server renumbered the
 * folder finds nothing.
 *
 * IMAP messages can't be changed, so updating a draft saves a new one and deletes the old: the
 * draft gets a new id. Received emails are only flagged or moved: archived, or moved to Trash. A
 * draft is sent over SMTP.
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

type SpecialUse = '\\Drafts' | '\\Sent' | '\\Trash' | '\\Archive' | '\\All';

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

// The folder a collection reads: the inbox, or the one the server marks as Drafts or Sent.
async function folderOf(client: ImapFlow, collectionId: string): Promise<Result<string, ApiError>> {
	if (collectionId === 'emails') {
		return Ok('INBOX');
	}
	if (collectionId === 'drafts') {
		return specialFolder(client, ['\\Drafts'], 'Drafts');
	}
	if (collectionId === 'sent') {
		return specialFolder(client, ['\\Sent'], 'Sent');
	}
	return Err(ApiErr.notFound('collection', collectionId));
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

// "Unread, Flagged".
function status(flags: Set<string> | undefined): string {
	const seen = flags?.has('\\Seen') ? 'Read' : 'Unread';
	if (flags?.has('\\Flagged')) {
		return `${seen}, Flagged`;
	}
	return seen;
}

function summaryValues(collectionId: string, message: FetchMessageObject): RecordValues {
	const envelope = message.envelope;
	if (collectionId === 'drafts') {
		return {to: formatAddresses(envelope?.to, false), subject: envelope?.subject ?? ''};
	}

	const at = message.internalDate ? new Date(message.internalDate).toISOString() : '';
	if (collectionId === 'sent') {
		return {to: formatAddresses(envelope?.to, true), subject: envelope?.subject ?? '', sentAt: at};
	}

	return {from: formatAddresses(envelope?.from, true), to: formatAddresses(envelope?.to, true), subject: envelope?.subject ?? '', receivedAt: at, status: status(message.flags)};
}

function updatedAt(message: FetchMessageObject): string {
	return message.internalDate ? new Date(message.internalDate).toISOString() : new Date(0).toISOString();
}

async function listMessages(target: RecordTarget, {client, mailbox}: Session): Promise<Result<DataRecord[], ApiError>> {
	if (mailbox.exists === 0) {
		return Ok([]);
	}

	const range = `${Math.max(1, mailbox.exists - LATEST + 1)}:*`;
	const messages = await client.fetchAll(range, {uid: true, envelope: true, internalDate: true, flags: true});
	return Ok(messages.sort((a, b) => b.uid - a.uid).map((message) => ({id: recordId(mailbox, message.uid), values: summaryValues(target.collection.id, message), updatedAt: updatedAt(message)})));
}

async function getMessage(target: RecordTarget, {client, mailbox}: Session, id: string): Promise<Result<DataRecord, ApiError>> {
	return Do(async ($) => {
		const uid = $(uidOf(mailbox, id));
		const message = await client.fetchOne(String(uid), {uid: true, envelope: true, internalDate: true, flags: true, source: true}, {uid: true});
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

/** The UID of the message the id names in the open folder, once the server confirms it is there. */
async function requireMessage({client, mailbox}: Session, id: string): Promise<Result<number, ApiError>> {
	return Do(async ($) => {
		const uid = $(uidOf(mailbox, id));
		if (!(await client.fetchOne(String(uid), {uid: true}, {uid: true}))) {
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

// Marks or unmarks an email, such as read or flagged, and reads it back.
function setFlag(flag: '\\Seen' | '\\Flagged', on: boolean): CommandRunner {
	return (target, recordId) =>
		withFolder(target, (session) =>
			Do(async ($) => {
				const uid = String($(await requireMessage(session, recordId)));
				if (on) {
					await session.client.messageFlagsAdd(uid, [flag], {uid: true});
				}
				if (!on) {
					await session.client.messageFlagsRemove(uid, [flag], {uid: true});
				}
				return $(await getMessage(target, session, recordId));
			}),
		);
}

// Moves an email to the folder the server marks for one of `uses`; it leaves the collection.
function moveTo(uses: SpecialUse[], name: string): CommandRunner {
	return (target, recordId) =>
		withFolder(target, (session) =>
			Do(async ($) => {
				const uid = $(await requireMessage(session, recordId));
				const path = $(await specialFolder(session.client, uses, name));
				await session.client.messageMove(String(uid), path, {uid: true});
				return null;
			}),
		);
}

// Files a copy of an email Proxy sent in the Sent folder.
async function fileInSent(client: ImapFlow, message: Mail.Options): Promise<Result<void, ApiError>> {
	return Do(async ($) => {
		const path = $(await specialFolder(client, ['\\Sent'], 'Sent'));
		const raw = await new MailComposer(message).compile().build();
		$((await Result.wrapAsync(() => client.append(path, raw, ['\\Seen']))).mapErr((cause) => ApiErr.providerUnreachable(cause)));
	});
}

/**
 * Sends the draft from the connected address, then files a copy in Sent (Gmail does that itself)
 * and deletes the draft. Once the email is out, a copy or a draft left behind is only logged: a
 * failure then would invite the agent to send it twice.
 */
async function sendDraft(target: RecordTarget, session: Session, recordId: string): Promise<Result<null, ApiError>> {
	return Do(async ($) => {
		const {client, credential} = session;
		const uid = $(uidOf(session.mailbox, recordId));
		const draft = $(await getMessage(target, session, recordId));
		const to = draft.values.to?.trim() ?? '';
		if (to === '') {
			return $(Err(ApiErr.validationError('The draft has no recipient')));
		}

		const message: Mail.Options = {from: credential.username, to, subject: draft.values.subject ?? '', text: draft.values.body ?? '', messageId: `<${randomUUID()}@proxy>`};
		const transport = smtpTransport(credential);
		const sent = await Result.wrapAsync(() => transport.sendMail(message));
		transport.close();
		$(sent.mapErr(smtpError));

		if (credential.smtpHost !== 'smtp.gmail.com') {
			const filed = await fileInSent(client, message);
			if (filed.isErr()) {
				log.warn('sent email not filed in Sent', serializeError(filed.error));
			}
		}

		const removed = await Result.wrapAsync(() => client.messageDelete(String(uid), {uid: true}));
		if (removed.isErr()) {
			log.warn('sent draft not deleted', serializeError(removed.error));
		}
		return null;
	});
}

export const emailConnector: Connector = {
	list: (target) => withFolder(target, (session) => listMessages(target, session)),
	get: (target, recordId) => withFolder(target, (session) => getMessage(target, session, recordId)),
	create: (target, values) => withFolder(target, (session) => appendDraft(target, session, values)),
	update: (target, recordId, values) =>
		withFolder(target, (session) =>
			Do(async ($) => {
				$(await requireMessage(session, recordId));
				const draft = $(await appendDraft(target, session, values));
				$(await deleteMessage(session, recordId));
				return draft;
			}),
		),
	remove: (target, recordId) => withFolder(target, (session) => deleteMessage(session, recordId)),
	commands: {
		markRead: setFlag('\\Seen', true),
		markUnread: setFlag('\\Seen', false),
		flag: setFlag('\\Flagged', true),
		unflag: setFlag('\\Flagged', false),
		archive: moveTo(['\\Archive', '\\All'], 'Archive'),
		trash: moveTo(['\\Trash'], 'Trash'),
		send: (target, recordId) => withFolder(target, (session) => sendDraft(target, session, recordId)),
	},
};
