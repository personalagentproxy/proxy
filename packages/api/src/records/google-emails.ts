import {randomUUID} from 'node:crypto';

import addressparser from 'nodemailer/lib/addressparser';
import MailComposer from 'nodemailer/lib/mail-composer';
import type Mail from 'nodemailer/lib/mailer';
import {Err, Ok, Result} from 'ts-results-es';

import {ApiErr, type ApiError, Do, requirePresent} from '@proxy/utils';

import {callGoogle} from '../connections/google/google-client';
import {
	attachmentNames,
	createDraft,
	deleteDraft,
	findDraftIds,
	folderOf,
	folderQuery,
	getDraft,
	getMessage,
	getMessageLabels,
	getMessageSummaries,
	GMAIL_ID,
	headerOf,
	listDrafts,
	listMessageIds,
	messageBody,
	messageHtml,
	modifyMessage,
	rawMessage,
	sendDraft,
	sendMessage,
	trashMessage,
	updateDraft,
	type GmailMessage,
	type MessagePart,
} from '../connections/google/gmail-api';
import type {CommandRunner, Connector, DataRecord, ListQuery, RecordPage, RecordTarget, RecordValues} from './connector';
import {gmailQuery, type EmailSearch} from './email-search';

/**
 * Gmail as the `emails` collection, fetched live, the same email as any mailbox's: one list, 50 to
 * a page with Gmail's own page token, newest first. Without a folder it is all mail but Spam and
 * Trash, as Gmail's All Mail is; a folder is one of Gmail's labels (Inbox, Draft, Sent, Trash,
 * Spam), or for the archive what has none of them. A search is Gmail's own, as in its search box.
 *
 * A record's id is Gmail's message id, except a draft's, which is `draft-<draft id>`: Gmail edits,
 * deletes and sends drafts by their draft id, which stays as the draft is edited while its message
 * id doesn't. The folder needn't be in the id, since an email's labels say which it is in.
 *
 * Marking read or unread takes the UNREAD label off or puts it on, starring the STARRED label,
 * archiving takes INBOX off, and moving to Trash is Gmail's trash, which keeps the email 30 days.
 * Nothing is deleted for good but drafts. Email goes out from the connection's own address, a draft
 * as it is saved or a new one written here; Gmail files it in Sent.
 */

type EmailRef = {kind: 'message'; messageId: string} | {kind: 'draft'; draftId: string};

function parseRef(recordId: string): EmailRef | null {
	const draft = /^draft-([A-Za-z0-9_-]+)$/.exec(recordId);
	if (draft?.[1]) {
		return {kind: 'draft', draftId: draft[1]};
	}
	if (GMAIL_ID.test(recordId)) {
		return {kind: 'message', messageId: recordId};
	}
	return null;
}

function requireRef(recordId: string): Result<EmailRef, ApiError> {
	const ref = parseRef(recordId);
	if (!ref) {
		return Err(ApiErr.notFound('record', recordId));
	}
	return Ok(ref);
}

// Drafts are edited, deleted and sent, by their draft ids; every other email only marked, starred
// or moved. A draft listed by its message id, when its draft id wasn't found among the drafts
// Gmail lists, is looked for again.
function requireDraft(token: string, recordId: string, refusal: string): Promise<Result<string, ApiError>> {
	return Do(async ($) => {
		const ref = $(requireRef(recordId));
		if (ref.kind === 'draft') {
			return ref.draftId;
		}
		const message = $((await getMessageLabels(token, ref.messageId)).mapErr(notFoundAs(recordId)));
		if (!isDraft(message)) {
			return $(Err(ApiErr.validationError(refusal)));
		}
		const draftId = $(await findDraftIds(token, [message.id])).get(message.id);
		return $(requirePresent(draftId, ApiErr.validationError(refusal)));
	});
}

function requireMessage(recordId: string): Result<string, ApiError> {
	return requireRef(recordId).andThen((ref) => (ref.kind === 'message' ? Ok(ref.messageId) : Err(ApiErr.validationError('Only for Inbox'))));
}

// Gmail says an id it never made is invalid rather than missing.
function notFoundAs(recordId: string) {
	return (error: ApiError): ApiError => {
		if (error.kind === 'not_found' || (error.kind === 'validation_error' && error.message.includes('Invalid id value'))) {
			return ApiErr.notFound('record', recordId);
		}
		return error;
	};
}

// Received email keeps the sender's name; a draft's addresses are bare, as they are typed.
function formatAddresses(header: string, withNames: boolean): string {
	return addressparser(header, {flatten: true})
		.map(({name, address}) => (withNames && name && address ? `${name} <${address}>` : address || name))
		.filter(Boolean)
		.join(', ');
}

// "Unread, Starred", for an email in the inbox.
function status(labelIds: string[]): string {
	const seen = labelIds.includes('UNREAD') ? 'Unread' : 'Read';
	if (labelIds.includes('STARRED')) {
		return `${seen}, Starred`;
	}
	return seen;
}

function dateOf(message: GmailMessage): string {
	return message.internalDate ? new Date(Number(message.internalDate)).toISOString() : '';
}

function summaryValues(message: GmailMessage): RecordValues {
	const labelIds = message.labelIds ?? [];
	const folder = folderOf(labelIds);
	const withNames = folder !== 'Draft';
	return {
		folder,
		from: formatAddresses(headerOf(message.payload, 'From'), withNames),
		to: formatAddresses(headerOf(message.payload, 'To'), withNames),
		subject: headerOf(message.payload, 'Subject'),
		date: dateOf(message),
		status: folder === 'Inbox' ? status(labelIds) : '',
	};
}

// The email in Gmail, in the account it is in, whichever of their accounts the person's browser
// opens first: a draft opens to be written, any other email in its conversation.
function webUrl(account: string, message: GmailMessage): string {
	const base = `https://mail.google.com/mail/?authuser=${encodeURIComponent(account)}`;
	if (isDraft(message)) {
		return `${base}#drafts?compose=${message.id}`;
	}
	return `${base}#all/${message.id}`;
}

function toRecord(account: string, recordId: string, message: GmailMessage, values: RecordValues = summaryValues(message)): DataRecord {
	return {id: recordId, values, updatedAt: dateOf(message) || new Date(0).toISOString(), url: webUrl(account, message)};
}

function fullRecord(account: string, recordId: string, message: GmailMessage): DataRecord {
	return toRecord(account, recordId, message, {...summaryValues(message), body: messageBody(message.payload)});
}

// A draft in the drafts, not one moved to Trash, which Gmail doesn't list among them.
function isDraft(message: GmailMessage): boolean {
	return folderOf(message.labelIds ?? []) === 'Draft';
}

// A message a list found but that was gone by the time it was opened is left out.
function present(messages: Array<Result<GmailMessage, ApiError>>): Result<Array<GmailMessage | null>, ApiError> {
	const kept: Array<GmailMessage | null> = [];
	for (const message of messages) {
		if (message.isErr() && message.error.kind !== 'not_found') {
			return message;
		}
		kept.push(message.isOk() ? message.value : null);
	}
	return Ok(kept);
}

/** A page of drafts, by their draft ids, matching the search. */
function listDraftsPage(token: string, account: string, query: ListQuery): Promise<Result<RecordPage, ApiError>> {
	return Do(async ($) => {
		const page = $(await listDrafts(token, query.search, query.page));
		const messages = $(
			present(
				await getMessageSummaries(
					token,
					page.items.map(({messageId}) => messageId),
				),
			),
		);
		const records = page.items.flatMap(({draftId}, index) => {
			const message = messages[index];
			return message ? [toRecord(account, `draft-${draftId}`, message)] : [];
		});
		return {records, nextPage: page.nextPage};
	});
}

/** A page of email in a folder, or all of it, matching the search; drafts in it by their draft ids. */
function listPage(target: RecordTarget, query: ListQuery): Promise<Result<RecordPage, ApiError>> {
	return callGoogle(target.connection, (token) =>
		Do(async ($) => {
			if (query.filter === 'Draft') {
				return $(await listDraftsPage(token, target.connection.account, query));
			}
			const page = $(await listMessageIds(token, folderQuery(query.filter, query.search), query.page));
			const messages = $(present(await getMessageSummaries(token, page.items))).flatMap((message) => (message ? [message] : []));
			const drafts = messages.filter(isDraft).map(({id}) => id);
			const draftIds = drafts.length > 0 ? $(await findDraftIds(token, drafts)) : new Map<string, string>();
			const records = messages.map((message) => {
				const draftId = draftIds.get(message.id);
				return toRecord(target.connection.account, draftId ? `draft-${draftId}` : message.id, message);
			});
			return {records, nextPage: page.nextPage};
		}),
	);
}

/**
 * The newest emails a search in Gmail's syntax finds, all mail but Spam and Trash, at most
 * `limit`, read with their headers alone: a list of a page would read 50. Drafts keep their
 * message ids, as they are only shown.
 */
// The newest emails one search finds, at most `limit`, each with who was copied, which the widgets find people in.
function findWithToken(token: string, account: string, search: EmailSearch, limit: number): Promise<Result<DataRecord[], ApiError>> {
	return Do(async ($) => {
		const page = $(await listMessageIds(token, folderQuery(null, gmailQuery(search)), null));
		const messages = $(present(await getMessageSummaries(token, page.items.slice(0, limit))));
		return messages.flatMap((message) => (message ? [toRecord(account, message.id, message, {...summaryValues(message), cc: formatAddresses(headerOf(message.payload, 'Cc'), true)})] : []));
	});
}

export function findGmailEmails(target: RecordTarget, searches: EmailSearch[], limit: number): Promise<Result<DataRecord[][], ApiError>> {
	return callGoogle(target.connection, async (token) => Result.all(await Promise.all(searches.map((search) => findWithToken(token, target.connection.account, search, limit)))));
}

function readDraft(token: string, account: string, recordId: string, draftId: string): Promise<Result<DataRecord, ApiError>> {
	return Do(async ($) => {
		const draft = $((await getDraft(token, draftId)).mapErr(notFoundAs(recordId)));
		return fullRecord(account, `draft-${draft.id}`, draft.message);
	});
}

// A message opened by its message id that turns out to be a draft is given its draft's id.
function readMessage(token: string, account: string, recordId: string, messageId: string): Promise<Result<DataRecord, ApiError>> {
	return Do(async ($) => {
		const message = $((await getMessage(token, messageId)).mapErr(notFoundAs(recordId)));
		const draftId = isDraft(message) ? $(await findDraftIds(token, [message.id])).get(message.id) : undefined;
		return fullRecord(account, draftId ? `draft-${draftId}` : message.id, message);
	});
}

function readRecord(token: string, account: string, recordId: string): Promise<Result<DataRecord, ApiError>> {
	return Do(async ($) => {
		const ref = $(requireRef(recordId));
		if (ref.kind === 'draft') {
			return $(await readDraft(token, account, recordId, ref.draftId));
		}
		return $(await readMessage(token, account, recordId, ref.messageId));
	});
}

// What a draft keeps of itself when it is written again, beyond the fields: who else it goes to,
// and the email it answers, so a reply stays in its thread.
type Kept = {cc: string; bcc: string; inReplyTo: string; references: string};

function keptOf(payload: MessagePart | undefined): Kept {
	return {cc: headerOf(payload, 'Cc'), bcc: headerOf(payload, 'Bcc'), inReplyTo: headerOf(payload, 'In-Reply-To'), references: headerOf(payload, 'References')};
}

/**
 * An email from the connection's address, as the IMAP connector writes one, as RFC 2822 text, with
 * an HTML version beside the text where one is kept.
 */
async function compose(from: string, values: RecordValues, kept: Kept | null, html: string | null = null): Promise<Result<Buffer, ApiError>> {
	const options: Mail.Options = {
		from,
		to: values.to,
		subject: values.subject,
		text: values.body,
		...(html !== null ? {html} : {}),
		messageId: `<${randomUUID()}@proxy>`,
		...(kept?.cc ? {cc: kept.cc} : {}),
		...(kept?.bcc ? {bcc: kept.bcc} : {}),
		...(kept?.inReplyTo ? {inReplyTo: kept.inReplyTo} : {}),
		...(kept?.references ? {references: kept.references} : {}),
	};
	const message = new MailComposer(options).compile();
	// A draft keeps its Bcc until it is sent; Gmail takes it out then.
	message.keepBcc = true;
	return (await Result.wrapAsync(() => message.build())).mapErr((cause) => ApiErr.internalError(cause));
}

function createDraftRecord(target: RecordTarget, values: RecordValues): Promise<Result<DataRecord, ApiError>> {
	return callGoogle(target.connection, (token) =>
		Do(async ($) => {
			const source = $(await compose(target.connection.account, values, null));
			const draft = $(await createDraft(token, rawMessage(source, null)));
			return $(await readDraft(token, target.connection.account, `draft-${draft.id}`, draft.id));
		}),
	);
}

/**
 * Writes a draft again with the fields given, the rest as they were, keeping its Cc, Bcc and
 * thread. A draft with attachments is refused: written again here, it would lose them. Recipients
 * written as they read, bare, keep their names, and the HTML version, as Gmail's own editor
 * writes one, is kept while the text is as it reads; text written differently goes out as text.
 */
function updateDraftRecord(target: RecordTarget, recordId: string, values: RecordValues): Promise<Result<DataRecord, ApiError>> {
	return callGoogle(target.connection, (token) =>
		Do(async ($) => {
			const draftId = $(await requireDraft(token, recordId, 'Only drafts can be edited or deleted'));
			const draft = $((await getDraft(token, draftId)).mapErr(notFoundAs(recordId)));
			const {payload, threadId} = draft.message;
			if (attachmentNames(payload).length > 0) {
				return $(Err(ApiErr.validationError('This draft has attachments, which editing it here would drop; edit it in Gmail')));
			}
			const current = {to: headerOf(payload, 'To'), subject: headerOf(payload, 'Subject'), body: messageBody(payload)};
			const written = {...current, ...values};
			const to = written.to === formatAddresses(current.to, false) ? current.to : written.to;
			const html = written.body === current.body ? messageHtml(payload) : null;
			const source = $(await compose(target.connection.account, {...written, to}, keptOf(payload), html));
			$(await updateDraft(token, draftId, rawMessage(source, threadId ?? null)));
			return $(await readDraft(token, target.connection.account, recordId, draftId));
		}),
	);
}

function removeDraft(target: RecordTarget, recordId: string): Promise<Result<void, ApiError>> {
	return callGoogle(target.connection, (token) =>
		Do(async ($) => {
			const draftId = $(await requireDraft(token, recordId, 'Only drafts can be edited or deleted'));
			$((await deleteDraft(token, draftId)).mapErr(notFoundAs(recordId)));
		}),
	);
}

// Changes an email's labels, as marking, starring and archiving do, and reads it back.
function relabel(change: {add?: string[]; remove?: string[]}): CommandRunner {
	return (target, recordId) =>
		callGoogle(target.connection, (token) =>
			Do(async ($) => {
				const messageId = $(requireMessage(recordId));
				$((await modifyMessage(token, messageId, change)).mapErr(notFoundAs(recordId)));
				return $(await readMessage(token, target.connection.account, recordId, messageId));
			}),
		);
}

// Moves an email to Trash and reads it back, there.
const trash: CommandRunner = (target, recordId) =>
	callGoogle(target.connection, (token) =>
		Do(async ($) => {
			const messageId = $(requireMessage(recordId));
			$((await trashMessage(token, messageId)).mapErr(notFoundAs(recordId)));
			return $(await readMessage(token, target.connection.account, recordId, messageId));
		}),
	);

function requireRecipient(to: string, cc: string, bcc: string): Result<void, ApiError> {
	if (`${to}${cc}${bcc}`.trim() === '') {
		return Err(ApiErr.validationError('The email has no recipient'));
	}
	return Ok(undefined);
}

// Sends a draft as it is saved; it leaves the drafts.
const send: CommandRunner = (target, recordId) =>
	callGoogle(target.connection, (token) =>
		Do(async ($) => {
			const draftId = $(await requireDraft(token, recordId, 'Only drafts can be sent'));
			const {payload} = $((await getDraft(token, draftId)).mapErr(notFoundAs(recordId))).message;
			$(requireRecipient(headerOf(payload, 'To'), headerOf(payload, 'Cc'), headerOf(payload, 'Bcc')));
			$((await sendDraft(token, draftId)).mapErr(notFoundAs(recordId)));
			return null;
		}),
	);

function sendNew(target: RecordTarget, values: RecordValues): Promise<Result<null, ApiError>> {
	return callGoogle(target.connection, (token) =>
		Do(async ($) => {
			$(requireRecipient(values.to ?? '', '', ''));
			const source = $(await compose(target.connection.account, values, null));
			$(await sendMessage(token, rawMessage(source, null)));
			return null;
		}),
	);
}

export const gmailConnector: Connector = {
	list: listPage,
	get: (target, recordId) => callGoogle(target.connection, (token) => readRecord(token, target.connection.account, recordId)),
	create: createDraftRecord,
	update: updateDraftRecord,
	remove: removeDraft,
	commands: {
		markRead: relabel({remove: ['UNREAD']}),
		markUnread: relabel({add: ['UNREAD']}),
		flag: relabel({add: ['STARRED']}),
		unflag: relabel({remove: ['STARRED']}),
		archive: relabel({remove: ['INBOX']}),
		trash,
		send,
	},
	newCommands: {sendNew},
};
