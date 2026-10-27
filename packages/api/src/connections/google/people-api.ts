import type {Result} from 'ts-results-es';
import {z} from 'zod';

import {type ApiError, Do} from '@proxy/utils';

import {googleRequest, googleWrite} from './google-client';

/**
 * The People v1 calls the `contacts` and `otherContacts` collections make, and the reading of their
 * answers: the account's contacts in Google Contacts, newest changed first, Google's search of them,
 * and making and changing one, a field at a time; and the people Gmail keeps under Other contacts,
 * listed, searched and copied into the contacts.
 */

const PEOPLE = 'https://people.googleapis.com/v1';

/** The contacts a page of a list holds; a search answers at most 30, Google's most. */
export const CONTACTS_PAGE_SIZE = 50;
const SEARCH_SIZE = 30;

/** The fields a contact is read with. */
const PERSON_FIELDS = 'names,emailAddresses,phoneNumbers,organizations,addresses,birthdays,biographies,metadata';

// Where an entry came from: the contact itself, or the person's own Google profile, which the
// contact shows beside it but isn't written.
const entryMetadataSchema = z.object({source: z.object({type: z.string().optional()}).optional()}).optional();

const valueEntrySchema = z.object({value: z.string().optional(), type: z.string().optional(), metadata: entryMetadataSchema});

export type ValueEntry = z.infer<typeof valueEntrySchema>;

const personSchema = z.object({
	resourceName: z.string(),
	etag: z.string().optional(),
	metadata: z.object({sources: z.array(z.object({type: z.string().optional(), id: z.string().optional(), etag: z.string().optional(), updateTime: z.string().optional()})).optional()}).optional(),
	names: z.array(z.object({displayName: z.string().optional(), unstructuredName: z.string().optional(), metadata: entryMetadataSchema})).optional(),
	emailAddresses: z.array(valueEntrySchema).optional(),
	phoneNumbers: z.array(valueEntrySchema).optional(),
	organizations: z.array(z.object({name: z.string().optional(), title: z.string().optional(), metadata: entryMetadataSchema})).optional(),
	addresses: z.array(z.object({formattedValue: z.string().optional(), type: z.string().optional(), metadata: entryMetadataSchema})).optional(),
	birthdays: z
		.array(z.object({date: z.object({year: z.number().optional(), month: z.number().optional(), day: z.number().optional()}).optional(), text: z.string().optional(), metadata: entryMetadataSchema}))
		.optional(),
	biographies: z.array(z.object({value: z.string().optional(), metadata: entryMetadataSchema})).optional(),
});

export type Person = z.infer<typeof personSchema>;

/** What a contact is written with: each field given replaces the contact's own entries of it. */
export type PersonWrite = {
	names?: Array<{unstructuredName: string}>;
	emailAddresses?: ValueEntry[];
	phoneNumbers?: ValueEntry[];
	organizations?: Array<{name?: string; title?: string}>;
	addresses?: Array<{formattedValue?: string; type?: string}>;
	birthdays?: Array<{date: {year?: number; month: number; day: number}}>;
	biographies?: Array<{value: string; contentType: 'TEXT_PLAIN'}>;
};

/** The fields an other contact is read with: all Google keeps of one. */
const OTHER_FIELDS = 'names,emailAddresses,phoneNumbers,metadata';

/** The most other contacts a page of Google's list holds. */
export const OTHER_CONTACTS_MAX_PAGE = 1000;

const connectionsSchema = z.object({connections: z.array(personSchema).optional(), nextPageToken: z.string().optional()});

const searchSchema = z.object({results: z.array(z.object({person: personSchema})).optional()});

/** A page of the account's contacts, the most recently changed first. */
export async function listContacts(accessToken: string, page: string | null): Promise<Result<{people: Person[]; nextPage: string | null}, ApiError>> {
	const url = new URL(`${PEOPLE}/people/me/connections`);
	url.searchParams.set('personFields', PERSON_FIELDS);
	url.searchParams.set('pageSize', String(CONTACTS_PAGE_SIZE));
	url.searchParams.set('sortOrder', 'LAST_MODIFIED_DESCENDING');
	if (page) {
		url.searchParams.set('pageToken', page);
	}
	const answer = await googleRequest(accessToken, url, connectionsSchema);
	return answer.map(({connections = [], nextPageToken}) => ({people: connections, nextPage: nextPageToken ?? null}));
}

function searchUrl(query: string): URL {
	const url = new URL(`${PEOPLE}/people:searchContacts`);
	url.searchParams.set('query', query);
	url.searchParams.set('readMask', PERSON_FIELDS);
	url.searchParams.set('pageSize', String(SEARCH_SIZE));
	return url;
}

/**
 * The contacts whose names, addresses, numbers or companies begin with the words searched for.
 * Google asks for an empty search first, which brings what it searches up to date.
 */
export function searchContacts(accessToken: string, query: string): Promise<Result<Person[], ApiError>> {
	return Do(async ($) => {
		$(await googleRequest(accessToken, searchUrl(''), searchSchema));
		const answer = $(await googleRequest(accessToken, searchUrl(query), searchSchema));
		return (answer.results ?? []).map(({person}) => person);
	});
}

function personUrl(resourceName: string, verb = ''): URL {
	return new URL(`${PEOPLE}/${resourceName}${verb}`);
}

export function getContact(accessToken: string, resourceName: string): Promise<Result<Person, ApiError>> {
	const url = personUrl(resourceName);
	url.searchParams.set('personFields', PERSON_FIELDS);
	return googleRequest(accessToken, url, personSchema);
}

export function createContact(accessToken: string, person: PersonWrite): Promise<Result<Person, ApiError>> {
	const url = new URL(`${PEOPLE}/people:createContact`);
	url.searchParams.set('personFields', PERSON_FIELDS);
	return googleWrite(accessToken, 'POST', url, person, personSchema);
}

/**
 * Replaces the fields given of a contact read as `before`, the rest as they are. Google turns the
 * change down where the contact changed since, by its etag.
 */
export function updateContact(accessToken: string, before: Person, person: PersonWrite): Promise<Result<Person, ApiError>> {
	const url = personUrl(before.resourceName, ':updateContact');
	url.searchParams.set('updatePersonFields', Object.keys(person).join(','));
	url.searchParams.set('personFields', PERSON_FIELDS);
	const sources = (before.metadata?.sources ?? []).filter((source) => source.type === 'CONTACT');
	return googleWrite(accessToken, 'PATCH', url, {...person, etag: before.etag, metadata: {sources}}, personSchema);
}

const otherContactsSchema = z.object({otherContacts: z.array(personSchema).optional(), nextPageToken: z.string().optional()});

/** A page of the account's other contacts, in Google's own order. */
export async function listOtherContacts(accessToken: string, page: string | null, pageSize = CONTACTS_PAGE_SIZE): Promise<Result<{people: Person[]; nextPage: string | null}, ApiError>> {
	const url = new URL(`${PEOPLE}/otherContacts`);
	url.searchParams.set('readMask', OTHER_FIELDS);
	url.searchParams.set('pageSize', String(pageSize));
	if (page) {
		url.searchParams.set('pageToken', page);
	}
	const answer = await googleRequest(accessToken, url, otherContactsSchema);
	return answer.map(({otherContacts = [], nextPageToken}) => ({people: otherContacts, nextPage: nextPageToken ?? null}));
}

function otherSearchUrl(query: string): URL {
	const url = new URL(`${PEOPLE}/otherContacts:search`);
	url.searchParams.set('query', query);
	url.searchParams.set('readMask', OTHER_FIELDS);
	url.searchParams.set('pageSize', String(SEARCH_SIZE));
	return url;
}

/** The other contacts whose names, addresses or numbers begin with the words searched for, after the empty search Google asks for first. */
export function searchOtherContacts(accessToken: string, query: string): Promise<Result<Person[], ApiError>> {
	return Do(async ($) => {
		$(await googleRequest(accessToken, otherSearchUrl(''), searchSchema));
		const answer = $(await googleRequest(accessToken, otherSearchUrl(query), searchSchema));
		return (answer.results ?? []).map(({person}) => person);
	});
}

/** Copies an other contact's names, addresses and numbers into a new contact in Google Contacts. */
export function copyOtherContact(accessToken: string, resourceName: string): Promise<Result<Person, ApiError>> {
	const body = {copyMask: 'names,emailAddresses,phoneNumbers', readMask: PERSON_FIELDS};
	return googleWrite(accessToken, 'POST', new URL(`${PEOPLE}/${resourceName}:copyOtherContactToMyContactsGroup`), body, personSchema);
}
