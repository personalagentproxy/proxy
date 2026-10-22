import {Err, Ok, type Result} from 'ts-results-es';

import {ApiErr, type ApiError, Do} from '@proxy/utils';

import {callGoogle} from '../connections/google/google-client';
import {createContact, getContact, listContacts, searchContacts, updateContact, type Person, type PersonWrite, type ValueEntry} from '../connections/google/people-api';
import {requireFirstPage, type Connector, type DataRecord, type ListQuery, type RecordPage, type RecordTarget, type RecordValues} from './connector';

/**
 * Google Contacts as the `contacts` collection, fetched live: the account's contacts, the most
 * recently changed first, 50 to a page with Google's own page token, or the 30 Google's search
 * finds first. A record's id is the contact's own, `c123…`, its resource name without `people/`.
 *
 * Emails and phone numbers are comma-separated, addresses one a line, and a birthday 1990-04-12,
 * or 04-12 without its year. An edit sends only the fields written differently, keeping the type
 * (work, home) of an email, number or address still there. What the person's own Google profile
 * shows beside the contact is read, never written. Contacts are never deleted here.
 */

// A contact's resource name without `people/`, as Google makes them.
const CONTACT_ID = /^c[0-9A-Za-z]{1,64}$/;

function requireContact(recordId: string): Result<string, ApiError> {
	if (!CONTACT_ID.test(recordId)) {
		return Err(ApiErr.notFound('record', recordId));
	}
	return Ok(`people/${recordId}`);
}

function notFoundAs(recordId: string) {
	return (error: ApiError): ApiError => (error.kind === 'not_found' ? ApiErr.notFound('record', recordId) : error);
}

// An entry the contact holds itself, not one shown from the person's own profile.
function ownEntry(entry: {metadata?: {source?: {type?: string}}}): boolean {
	const type = entry.metadata?.source?.type;
	return type === undefined || type === 'CONTACT';
}

function joined(entries: Array<{value?: string}> | undefined, separator: string): string {
	const values = (entries ?? []).flatMap((entry) => (entry.value?.trim() ? [entry.value.trim()] : []));
	return [...new Set(values)].join(separator);
}

const pad = (n: number) => String(n).padStart(2, '0');

function birthdayOf(person: Person): string {
	const birthday = person.birthdays?.[0];
	const date = birthday?.date;
	if (date?.month && date.day) {
		const day = `${pad(date.month)}-${pad(date.day)}`;
		return date.year ? `${date.year}-${day}` : day;
	}
	return birthday?.text ?? '';
}

function contactValues(person: Person): RecordValues {
	const organization = person.organizations?.[0];
	const name = person.names?.[0];
	return {
		name: name?.displayName ?? name?.unstructuredName ?? '',
		emails: joined(person.emailAddresses, ', '),
		phones: joined(person.phoneNumbers, ', '),
		company: organization?.name ?? '',
		jobTitle: organization?.title ?? '',
		// An address Google wrote over several lines is one line here, so each line is one address.
		addresses: joined(
			person.addresses?.map((address) => ({value: address.formattedValue?.replace(/\s*\n\s*/g, ', ')})),
			'\n',
		),
		birthday: birthdayOf(person),
		notes: person.biographies?.[0]?.value ?? '',
	};
}

function idOf(person: Person): string {
	return person.resourceName.replace(/^people\//, '');
}

function updatedAt(person: Person): string {
	const own = person.metadata?.sources?.find((source) => source.type === 'CONTACT');
	return own?.updateTime ?? new Date(0).toISOString();
}

function contactRecord(person: Person): DataRecord {
	return {id: idOf(person), values: contactValues(person), updatedAt: updatedAt(person), url: `https://contacts.google.com/person/${idOf(person)}`};
}

function listContactsPage(target: RecordTarget, query: ListQuery): Promise<Result<RecordPage, ApiError>> {
	return callGoogle(target.connection, (token) =>
		Do(async ($) => {
			if (query.search !== null) {
				$(requireFirstPage(query));
				return {records: $(await searchContacts(token, query.search)).map(contactRecord), nextPage: null};
			}
			const page = $(await listContacts(token, query.page));
			return {records: page.people.map(contactRecord), nextPage: page.nextPage};
		}),
	);
}

function getContactRecord(target: RecordTarget, recordId: string): Promise<Result<DataRecord, ApiError>> {
	return callGoogle(target.connection, (token) =>
		Do(async ($) => {
			const person = $((await getContact(token, $(requireContact(recordId)))).mapErr(notFoundAs(recordId)));
			return contactRecord(person);
		}),
	);
}

function parts(text: string, separator: RegExp): string[] {
	return [
		...new Set(
			text
				.split(separator)
				.map((part) => part.trim())
				.filter(Boolean),
		),
	];
}

const EMAIL = /^[^\s@<>(),;"']+@[^\s@<>(),;"']+\.[^\s@<>(),;"']+$/;

function parseEmails(text: string): Result<string[], ApiError> {
	const emails = parts(text, /[,;\n]/);
	const wrong = emails.find((email) => !EMAIL.test(email));
	if (wrong !== undefined) {
		return Err(ApiErr.validationError(`Write each email as an address, not “${wrong}”`));
	}
	return Ok(emails);
}

// The entries for the values written: one still there keeps its type, a new one has none.
function entriesFor(values: string[], existing: ValueEntry[] | undefined, same: (a: string, b: string) => boolean): ValueEntry[] {
	const own = (existing ?? []).filter(ownEntry);
	return values.map((value) => {
		const kept = own.find((entry) => same(entry.value ?? '', value));
		return kept?.type ? {value, type: kept.type} : {value};
	});
}

const sameEmail = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
const samePhone = (a: string, b: string) => a.replace(/[^\d+]/g, '') === b.replace(/[^\d+]/g, '');

const BIRTHDAY = /^(?:(\d{4})-)?(\d{2})-(\d{2})$/;

function parseBirthday(text: string): Result<PersonWrite['birthdays'], ApiError> {
	const trimmed = text.trim();
	if (trimmed === '') {
		return Ok([]);
	}
	const [, year, month = '', day = ''] = BIRTHDAY.exec(trimmed) ?? [];
	const date = new Date(Date.UTC(year ? Number(year) : 2000, Number(month) - 1, Number(day)));
	if (!month || date.getUTCMonth() !== Number(month) - 1 || date.getUTCDate() !== Number(day)) {
		return Err(ApiErr.validationError(`Write the birthday as 1990-04-12, or 04-12 without the year, not “${trimmed}”`));
	}
	return Ok([{date: {...(year ? {year: Number(year)} : {}), month: Number(month), day: Number(day)}}]);
}

/** The fields written differently from `before`, each as Google takes it; every field written for a new contact. */
function contactWrite(values: RecordValues, before: Person | null): Result<PersonWrite, ApiError> {
	return Do<PersonWrite, ApiError>(($) => {
		const old = before ? contactValues(before) : null;
		const changed = (key: string) => old === null || (values[key] ?? '').trim() !== (old[key] ?? '').trim();
		const write: PersonWrite = {};
		const value = (key: string) => (values[key] ?? '').trim();
		if (changed('name')) {
			write.names = value('name') ? [{unstructuredName: value('name')}] : [];
		}
		if (changed('emails')) {
			write.emailAddresses = entriesFor($(parseEmails(value('emails'))), before?.emailAddresses, sameEmail);
		}
		if (changed('phones')) {
			write.phoneNumbers = entriesFor(parts(value('phones'), /[,;\n]/), before?.phoneNumbers, samePhone);
		}
		if (changed('company') || changed('jobTitle')) {
			const others = (before?.organizations ?? [])
				.filter(ownEntry)
				.slice(1)
				.map(({name, title}) => ({name, title}));
			const first = value('company') || value('jobTitle') ? [{name: value('company'), title: value('jobTitle')}] : [];
			write.organizations = [...first, ...others];
		}
		if (changed('addresses')) {
			const own = (before?.addresses ?? []).filter(ownEntry);
			write.addresses = parts(value('addresses'), /\n/).map((formattedValue) => {
				const kept = own.find((address) => address.formattedValue?.replace(/\s*\n\s*/g, ', ') === formattedValue);
				return kept ? {formattedValue: kept.formattedValue, type: kept.type} : {formattedValue};
			});
		}
		if (changed('birthday')) {
			write.birthdays = $(parseBirthday(value('birthday')));
		}
		if (changed('notes')) {
			write.biographies = value('notes') ? [{value: values.notes ?? '', contentType: 'TEXT_PLAIN'}] : [];
		}
		return write;
	});
}

function createContactRecord(target: RecordTarget, values: RecordValues): Promise<Result<DataRecord, ApiError>> {
	return callGoogle(target.connection, (token) =>
		Do(async ($) => {
			if (Object.values(values).every((value) => value.trim() === '')) {
				return $(Err(ApiErr.validationError('Write at least a name, an email or a phone number for the contact')));
			}
			const write = $(contactWrite(values, null));
			return contactRecord($(await createContact(token, write)));
		}),
	);
}

function updateContactRecord(target: RecordTarget, recordId: string, values: RecordValues): Promise<Result<DataRecord, ApiError>> {
	return callGoogle(target.connection, (token) =>
		Do(async ($) => {
			const before = $((await getContact(token, $(requireContact(recordId)))).mapErr(notFoundAs(recordId)));
			const write = $(contactWrite(values, before));
			if (Object.keys(write).length === 0) {
				return contactRecord(before);
			}
			return contactRecord($((await updateContact(token, before, write)).mapErr(notFoundAs(recordId))));
		}),
	);
}

function notDeleted(): Promise<Result<never, ApiError>> {
	return Promise.resolve(Err(ApiErr.validationError('Contacts in Google Contacts are never deleted here')));
}

export const contactsConnector: Connector = {
	list: listContactsPage,
	get: getContactRecord,
	create: (target, values) => createContactRecord(target, values),
	update: (target, recordId, values) => updateContactRecord(target, recordId, values),
	remove: notDeleted,
};
