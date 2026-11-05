import {Err, Ok, type Result} from 'ts-results-es';

import {ApiErr, type ApiError, Do} from '@proxy/utils';

import {callGoogle} from '../connections/google/google-client';
import {createLabel, getLabel, GMAIL_ID, listLabels, modifyMessage, type GmailLabel} from '../connections/google/gmail-api';
import {requireEmailId} from './attachment-text';
import {requireFirstPage, type DataRecord, type ListQuery, type NewCommandRunner, type RecordPage, type RecordStore, type RecordTarget, type RecordValues} from './connector';

/**
 * Gmail's labels of the account's own, as the `labels` collection, fetched live: listed by name,
 * all on one page as Gmail lists them, a search narrowing them to the names holding its words. A
 * record's id is Gmail's label id. Gmail's own labels, Inbox, Starred, Unread, Important, Spam,
 * Trash and the categories, are never listed nor put on or taken off here: archiving, starring,
 * marking and moving to Trash are the `emails` collection's commands, each with its own action.
 *
 * Putting a label on an email makes the label where the account has none of that name, as Gmail's
 * own Label as does; taking one off leaves the label, and the email, where they are. A draft isn't
 * labelled, since Gmail gives a draft a new message, without its labels, every time it is edited.
 */

const NEVER = new Date(0).toISOString();

// Gmail gives the labels an account makes ids of their own kind; its own are named in capitals.
const OWN_LABEL = /^Label_/;

// Gmail matches label names without minding case: it refuses a second "clients" beside "Clients".
const sameName = (one: string, other: string): boolean => one.toLocaleLowerCase() === other.toLocaleLowerCase();

// The label's page in Gmail, in the account it is in.
function webUrl(account: string, name: string): string {
	return `https://mail.google.com/mail/?authuser=${encodeURIComponent(account)}#label/${encodeURIComponent(name)}`;
}

function toRecord(account: string, label: GmailLabel, values: RecordValues = {label: label.name}): DataRecord {
	return {id: label.id, values, updatedAt: NEVER, url: webUrl(account, label.name)};
}

/** The names of the account's own labels among an email's label ids, comma-separated, in Gmail's order; Gmail's own are left out. */
export function labelNames(token: string, labelIds: string[]): Promise<Result<string, ApiError>> {
	return Do(async ($) => {
		if (!labelIds.some((id) => OWN_LABEL.test(id))) {
			return '';
		}
		const labels = $(await listLabels(token));
		return labels
			.filter((label) => label.type === 'user' && labelIds.includes(label.id))
			.map((label) => label.name)
			.join(', ');
	});
}

function listOwn(target: RecordTarget, query: ListQuery): Promise<Result<RecordPage, ApiError>> {
	return callGoogle(target.connection, (token) =>
		Do(async ($) => {
			$(requireFirstPage(query));
			const words = (query.search ?? '').toLocaleLowerCase().split(/\s+/).filter(Boolean);
			const labels = $(await listLabels(token))
				.filter((label) => label.type === 'user')
				.filter((label) => words.every((word) => label.name.toLocaleLowerCase().includes(word)))
				.sort((one, other) => one.name.localeCompare(other.name));
			return {records: labels.map((label) => toRecord(target.connection.account, label)), nextPage: null};
		}),
	);
}

function getOwn(target: RecordTarget, recordId: string): Promise<Result<DataRecord, ApiError>> {
	return callGoogle(target.connection, (token) =>
		Do(async ($) => {
			if (!OWN_LABEL.test(recordId) || !GMAIL_ID.test(recordId)) {
				return $(Err(ApiErr.notFound('record', recordId)));
			}
			const label = $((await getLabel(token, recordId)).mapErr((error) => (error.kind === 'not_found' ? ApiErr.notFound('record', recordId) : error)));
			if (label.type !== 'user') {
				return $(Err(ApiErr.notFound('record', recordId)));
			}
			return toRecord(target.connection.account, label, {label: label.name, messages: String(label.messagesTotal ?? 0), unread: String(label.messagesUnread ?? 0)});
		}),
	);
}

// The email a label goes on or comes off, by its message id; a draft is turned down.
function requireMessage(values: RecordValues): Result<string, ApiError> {
	return requireEmailId(values).andThen((email) => {
		if (email.startsWith('draft-')) {
			return Err(ApiErr.validationError('A draft isn’t labelled: Gmail drops its labels each time it is edited. Label it once it is sent'));
		}
		if (!GMAIL_ID.test(email)) {
			return Err(ApiErr.notFound('record', email));
		}
		return Ok(email);
	});
}

function requireName(values: RecordValues): Result<string, ApiError> {
	const name = (values.label ?? '').trim();
	if (name === '') {
		return Err(ApiErr.validationError('Say which label as label: its name, as labels_list gives it'));
	}
	return Ok(name);
}

// One of Gmail's own labels is changed by the command doing what it stands for, with its own action.
function refuseGmailOwn(labels: GmailLabel[], name: string): Result<void, ApiError> {
	const own = labels.find((label) => label.type === 'system' && (sameName(label.name, name) || sameName(label.id, name)));
	if (own) {
		return Err(ApiErr.validationError(`${own.name} is one of Gmail’s own labels, not put on or taken off here: archiving, starring, marking read and moving to Trash each have their own tool`));
	}
	return Ok(undefined);
}

// Gmail says an id it never made is invalid rather than missing.
function emailNotFound(email: string) {
	return (error: ApiError): ApiError => {
		if (error.kind === 'not_found' || (error.kind === 'validation_error' && error.message.includes('Invalid id value'))) {
			return ApiErr.notFound('record', email);
		}
		return error;
	};
}

// Puts the label of the name on the email, making it first where the account has none of that name.
const add: NewCommandRunner = (target, values) =>
	callGoogle(target.connection, (token) =>
		Do(async ($) => {
			const email = $(requireMessage(values));
			const name = $(requireName(values));
			const labels = $(await listLabels(token));
			$(refuseGmailOwn(labels, name));
			const found = labels.find((label) => label.type === 'user' && sameName(label.name, name));
			const label = found ?? $(await createLabel(token, name));
			$((await modifyMessage(token, email, {add: [label.id]})).mapErr(emailNotFound(email)));
			return toRecord(target.connection.account, label, {label: label.name, email, made: found ? 'No' : 'Yes'});
		}),
	);

// Takes the label of the name off the email; the label stays, on the rest of the email it is on.
const remove: NewCommandRunner = (target, values) =>
	callGoogle(target.connection, (token) =>
		Do(async ($) => {
			const email = $(requireMessage(values));
			const name = $(requireName(values));
			const labels = $(await listLabels(token));
			$(refuseGmailOwn(labels, name));
			const label = labels.find((each) => each.type === 'user' && sameName(each.name, name));
			if (!label) {
				return $(Err(ApiErr.validationError(`The account has no label named ${name}`)));
			}
			$((await modifyMessage(token, email, {remove: [label.id]})).mapErr(emailNotFound(email)));
			return toRecord(target.connection.account, label, {label: label.name, email});
		}),
	);

export const gmailLabelsConnector = {
	list: listOwn,
	get: getOwn,
	newCommands: {add, remove},
} satisfies RecordStore;
