import {Err, Ok, type Result} from 'ts-results-es';

import {ApiErr, type ApiError, Do} from '@proxy/utils';

import {callGoogle} from '../connections/google/google-client';
import {copyOtherContact, listOtherContacts, OTHER_CONTACTS_MAX_PAGE, searchOtherContacts, type Person} from '../connections/google/people-api';
import {contactValues} from './google-contacts';
import {requireFirstPage, type CommandRunner, type Connector, type DataRecord, type ListQuery, type RecordPage, type RecordTarget} from './connector';

/**
 * The people Gmail keeps under Other contacts, as the `otherContacts` collection, fetched live:
 * those the account emailed or was emailed by but never saved, 50 to a page in Google's own order,
 * or the 30 Google's search finds first. Google keeps only their names, addresses and numbers, and
 * they are only read. A record's id is Google's, `c123…`, its resource name without
 * `otherContacts/`. Saving one copies it into Google Contacts as a contact of its own.
 */

// An other contact's resource name without `otherContacts/`, as Google makes them.
const OTHER_ID = /^c[0-9A-Za-z]{1,64}$/;

// Google opens no other contact on its own, so one is found in its list; the pages read at most,
// of 1000 each.
const MAX_PAGES = 20;

const NEVER = new Date(0).toISOString();

function requireOther(recordId: string): Result<string, ApiError> {
	if (!OTHER_ID.test(recordId)) {
		return Err(ApiErr.notFound('record', recordId));
	}
	return Ok(`otherContacts/${recordId}`);
}

function otherRecord(person: Person): DataRecord {
	const {name = '', emails = '', phones = ''} = contactValues(person);
	const updatedAt = person.metadata?.sources?.find((source) => source.updateTime)?.updateTime ?? NEVER;
	return {id: person.resourceName.replace(/^otherContacts\//, ''), values: {name, emails, phones}, updatedAt};
}

function listOthers(target: RecordTarget, query: ListQuery): Promise<Result<RecordPage, ApiError>> {
	return callGoogle(target.connection, (token) =>
		Do(async ($) => {
			if (query.search !== null) {
				$(requireFirstPage(query));
				return {records: $(await searchOtherContacts(token, query.search)).map(otherRecord), nextPage: null};
			}
			const page = $(await listOtherContacts(token, query.page));
			return {records: page.people.map(otherRecord), nextPage: page.nextPage};
		}),
	);
}

// Looks for the other contact page by page of Google's list.
async function findOther(token: string, resourceName: string, recordId: string): Promise<Result<Person, ApiError>> {
	let page: string | null = null;
	for (let read = 0; read < MAX_PAGES; read++) {
		const answer = await listOtherContacts(token, page, OTHER_CONTACTS_MAX_PAGE);
		if (answer.isErr()) {
			return answer;
		}
		const found = answer.value.people.find((person) => person.resourceName === resourceName);
		if (found) {
			return Ok(found);
		}
		if (answer.value.nextPage === null) {
			break;
		}
		page = answer.value.nextPage;
	}
	return Err(ApiErr.notFound('record', recordId));
}

function getOther(target: RecordTarget, recordId: string): Promise<Result<DataRecord, ApiError>> {
	return callGoogle(target.connection, (token) =>
		Do(async ($) => {
			return otherRecord($(await findOther(token, $(requireOther(recordId)), recordId)));
		}),
	);
}

/** Copies the other contact into Google Contacts, where it is a contact of its own from then on. */
const save: CommandRunner = (target, recordId) =>
	callGoogle(target.connection, (token) =>
		Do(async ($) => {
			const resourceName = $(requireOther(recordId));
			$((await copyOtherContact(token, resourceName)).mapErr((error) => (error.kind === 'not_found' ? ApiErr.notFound('record', recordId) : error)));
			return null;
		}),
	);

function onlyRead(): Promise<Result<never, ApiError>> {
	return Promise.resolve(Err(ApiErr.validationError('Other contacts are only read; save one to contacts to edit it there')));
}

export const otherContactsConnector: Connector = {list: listOthers, get: getOther, create: onlyRead, update: onlyRead, remove: onlyRead, commands: {save}};
