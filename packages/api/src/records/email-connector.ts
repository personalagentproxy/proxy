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
 * A mailbox over IMAP, signed in fresh for every request. Its one list is the latest messages of
 * the inbox and the folders the server marks as Drafts and Sent, newest first, each saying which
 * it is in. A record's id is the folder, the folder's UIDVALIDITY and the message's UID, so an id
 * from before the server renumbered the folder finds nothing.
 *
 * IMAP messages can't be changed, so updating a draft saves a new one and deletes the old: the
 * draft gets a new id. Received emails are only flagged or moved: archived, or moved to Trash.
 * Email goes out over SMTP, from a draft or straight from values typed in.
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

/** Signs in, runs `work`, and always signs out again. */
async function withClient<T>(target: RecordTarget, work: (client: ImapFlow, credential: EmailCredential) => Promise<Result<T, ApiError>>): Promise<Result<T, ApiError>> {
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

	const outcome = (await Result.wrapAsync(() => work(client, credential.value))).mapErr((cause) => ApiErr.providerUnreachable(cause)).andThen((result) => result);
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

function withFolder<T>(target: RecordTarget, folder: Folder, work: (session: Session) => Promise<Result<T, ApiError>>): Promise<Result<T, ApiError>> {
	return withClient(target, (client, credential) => inFolder(client, credential, folder, work));
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

async function listMessages(session: Session): Promise<Result<DataRecord[], ApiError>> {
	const {client, mailbox, folder} = session;
	if (mailbox.exists === 0) {
		return Ok([]);
	}

	const range = `${Math.max(1, mailbox.exists - LATEST + 1)}:*`;
	const messages = await client.fetchAll(range, {uid: true, envelope: true, internalDate: true, flags: true});
	return Ok(messages.map((message) => ({id: recordId(session, message.uid), values: summaryValues(folder, message), updatedAt: updatedAt(message)})));
}

/** The latest of every folder, newest first. A server without a Drafts or Sent folder lists the rest. */
function listAll(target: RecordTarget): Promise<Result<DataRecord[], ApiError>> {
	return withClient(target, async (client, credential) => {
		const records: DataRecord[] = [];
		for (const folder of FOLDERS) {
			const listed = await inFolder(client, credential, folder, listMessages);
			if (listed.isErr() && listed.error.kind === 'not_found') {
				continue;
			}
			if (listed.isErr()) {
				return listed;
			}
			records.push(...listed.value);
		}
		return Ok(records.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, LATEST));
	});
}

async function getMessage(session: Session, id: string): Promise<Result<DataRecord, ApiError>> {
	return Do(async ($) => {
		const uid = $(uidOf(session, id));
		const message = await session.client.fetchOne(String(uid), {uid: true, envelope: true, internalDate: true, flags: true, source: true}, {uid: true});
		if (!message || !message.source) {
			return $(Err(ApiErr.notFound('record', id)));
		}

		const source = message.source;
		const parsed = $((await Result.wrapAsync(() => simpleParser(source))).mapErr((cause) => ApiErr.providerUnreachable(cause)));
		const body = (parsed.text ?? '').trim();
		return {id, values: {...summaryValues(session.folder, message), body}, updatedAt: updatedAt(message)};
	});
}

/** Saves a draft from the typed-in values, from the connected address, and reads it back. */
async function appendDraft(session: Session, values: RecordValues): Promise<Result<DataRecord, ApiError>> {
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
 * Sends an email from the connected address, then files a copy in Sent (Gmail does that itself).
 * Once the email is out, a copy left unfiled is only logged: a failure then would invite the agent
 * to send it twice.
 */
async function deliver(client: ImapFlow, credential: EmailCredential, values: RecordValues): Promise<Result<void, ApiError>> {
	return Do(async ($) => {
		const to = values.to?.trim() ?? '';
		if (to === '') {
			return $(Err(ApiErr.validationError('The email has no recipient')));
		}

		const message: Mail.Options = {from: credential.username, to, subject: values.subject ?? '', text: values.body ?? '', messageId: `<${randomUUID()}@proxy>`};
		const transport = smtpTransport(credential);
		const sent = await Result.wrapAsync(() => transport.sendMail(message));
		transport.close();
		$(sent.mapErr(smtpError));

		if (credential.smtpHost === 'smtp.gmail.com') {
			return;
		}
		const filed = await Do<void, ApiError>(async ($$) => {
			const path = $$(await specialFolder(client, ['\\Sent'], 'Sent'));
			const raw = await new MailComposer(message).compile().build();
			$$((await Result.wrapAsync(() => client.append(path, raw, ['\\Seen']))).mapErr((cause) => ApiErr.providerUnreachable(cause)));
		});
		if (filed.isErr()) {
			log.warn('sent email not filed in Sent', serializeError(filed.error));
		}
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

export const emailConnector: Connector = {
	list: listAll,
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
};
