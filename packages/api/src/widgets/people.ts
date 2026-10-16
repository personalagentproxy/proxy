import addressparser from 'nodemailer/lib/addressparser';
import type {Result} from 'ts-results-es';
import {z} from 'zod';

import {type ApiError, Do, parseSchema} from '@proxy/utils';

import type {AuthenticatedRequest} from '../server/middleware/require-auth';
import {requireUserOrgId} from '../utils/user-org';
import type {DataRecord} from '../records/connector';
import {eachSource, type Failure} from './each-source';
import {searchable} from './mail-searches';
import {findSources, summarize, type Source, type SourceSummary} from './sources';

/**
 * People by name, for the widgets that name someone: the contact itself, the guests of an event,
 * the recipients of an email. Every contact book connected is searched, as its provider searches
 * it, and every mailbox for the people its email is from, to or copied to, since many a person
 * written to was never saved as a contact. What they find is one list per name: the closest names
 * first, contacts before people only in email, each person once.
 */

/**
 * A person: a contact, read from the `contacts` collection's fields, which every contact book
 * shares, or someone in a mailbox's email, known by their name and address alone.
 */
export type Person = {
	// Where they were found: a contact book, or the email of a mailbox.
	origin: 'contacts' | 'email';
	connectionId: string;
	id: string;
	name: string;
	emails: string[];
	phones: string[];
	company: string;
	jobTitle: string;
	addresses: string[];
	link: string | null;
};

export type PeopleAnswer = {sources: SourceSummary[]; people: Array<{name: string; matches: Person[]}>; failed: Failure[]};

// The people a name finds at most, the closest first.
const MATCHES = 5;

// The newest emails involving a name read for the people in them, in each mailbox.
const EMAILS_READ = 10;

const querySchema = z.object({
	name: z.union([z.string(), z.array(z.string())]).transform((names) => (Array.isArray(names) ? names : [names]).map((name) => name.trim().slice(0, 100)).filter((name) => name !== '')),
});

function split(text: string | undefined, separator: RegExp): string[] {
	return (text ?? '')
		.split(separator)
		.map((part) => part.trim())
		.filter((part) => part !== '');
}

export function personOf(connectionId: string, record: DataRecord): Person {
	const {values} = record;
	return {
		origin: 'contacts',
		connectionId,
		id: record.id,
		name: values.name ?? '',
		emails: split(values.emails, /,/),
		phones: split(values.phones, /,/),
		company: values.company ?? '',
		jobTitle: values.jobTitle ?? '',
		addresses: split(values.addresses, /\n/),
		link: record.url ?? null,
	};
}

// How closely a contact's name is the one written: all of it, its beginning, or one of its words
// beginning with the first word written ("Jacky" for Jacky Doe); a contact the provider found by
// its address or company comes last.
function closeness(person: Person, name: string): number {
	const wanted = name.toLowerCase();
	const full = person.name.toLowerCase();
	if (full === wanted) {
		return 3;
	}
	if (full.startsWith(wanted)) {
		return 2;
	}
	const [first = ''] = wanted.split(/\s+/);
	if (full.split(/\s+/).some((word) => word.startsWith(first))) {
		return 1;
	}
	return 0;
}

// An address mail is sent from by a machine, which nobody writes back to: Google Drive's sharing
// notices come from drive-shares-dm-noreply@google.com under the sharer's name.
const AUTOMATED = /(^|[-_.+])(no-?reply|do-?not-?reply|notifications?|mailer-daemon|bounces?)([-_.+]|@)/;

function automated(address: string): boolean {
	return AUTOMATED.test(address);
}

/**
 * The people in a mailbox's emails, from, to or copied, whose names, or addresses where they have
 * none, are close to the one written, those in the most emails first, the mailbox's own account
 * left out. Gmail and IMAP find an email by anyone in it, so the rest of those in it are someone else.
 */
export function peopleInEmails(connectionId: string, account: string, records: DataRecord[], name: string): Person[] {
	const found = new Map<string, {name: string; count: number}>();
	for (const record of records) {
		const {from = '', to = '', cc = ''} = record.values;
		const addresses = addressparser(`${from}, ${to}, ${cc}`, {flatten: true});
		for (const {name: written, address} of addresses) {
			const key = address?.toLowerCase();
			if (!key || key === account.toLowerCase() || automated(key)) {
				continue;
			}
			const known = found.get(key);
			found.set(key, {name: known?.name || written.trim(), count: (known?.count ?? 0) + 1});
		}
	}
	return [...found.entries()]
		.sort(([, a], [, b]) => b.count - a.count)
		.map(([address, seen]): Person => ({origin: 'email', connectionId, id: address, name: seen.name || address, emails: [address], phones: [], company: '', jobTitle: '', addresses: [], link: null}))
		.filter((person) => closeness(person, name) > 0);
}

// A name as two people's are compared: its first and last word, without case or accents, so
// "Arne Elmar Strickmann" is "Arne Strickmann". None for one word or an address, which say too
// little to be sure.
function nameKey(person: Person): string | null {
	if (person.name.includes('@')) {
		return null;
	}
	const words = person.name
		.toLowerCase()
		.normalize('NFKD')
		.replace(/[\u0300-\u036f]/g, '')
		.split(/[\s,.]+/)
		.filter((word) => word !== '');
	const [first] = words;
	const last = words.at(-1);
	return first && last && words.length > 1 ? `${first} ${last}` : null;
}

function uniqueAddresses(addresses: string[]): string[] {
	const seen = new Set<string>();
	return addresses.filter((address) => {
		const key = address.toLowerCase();
		if (seen.has(key)) {
			return false;
		}
		seen.add(key);
		return true;
	});
}

/**
 * Everyone found more than once as one person: the same address in two contact books or
 * mailboxes, or the same first and last name, as someone writing from work and from home is. A
 * contact leads, saying more; else the first found, whose address is the one most written. Their
 * addresses, numbers and postal addresses are all kept, the leader's first.
 */
export function mergePeople(people: Person[]): Person[] {
	const merged: Person[] = [];
	for (const person of people) {
		const key = nameKey(person);
		const addresses = person.emails.map((email) => email.toLowerCase());
		const same = merged.findIndex((one) => (key !== null && nameKey(one) === key) || one.emails.some((email) => addresses.includes(email.toLowerCase())));
		const kept = merged[same];
		if (!kept) {
			merged.push(person);
			continue;
		}
		const [lead, other] = kept.origin === 'email' && person.origin === 'contacts' ? [person, kept] : [kept, person];
		merged[same] = {
			...lead,
			emails: uniqueAddresses([...lead.emails, ...other.emails]),
			phones: [...new Set([...lead.phones, ...other.phones])],
			addresses: [...new Set([...lead.addresses, ...other.addresses])],
		};
	}
	return merged;
}

/** The closest people first, a contact before someone only in email, each once, at most five. */
export function rankPeople(people: Person[], name: string): Person[] {
	return mergePeople(people)
		.map((person, index) => ({person, index, score: closeness(person, name)}))
		.sort((a, b) => b.score - a.score || Number(a.person.origin === 'email') - Number(b.person.origin === 'email') || a.index - b.index)
		.map(({person}) => person)
		.slice(0, MATCHES);
}

// The people a name finds in one contact book, as its provider searches it.
function searchContacts(source: Source, name: string): Promise<Result<Person[], ApiError>> {
	return source.connector.list(source, {search: name, page: null, filter: null, parent: null}).then((page) => page.map(({records}) => records.map((record) => personOf(source.connection.id, record))));
}

/** `GET /api/widgets/people?name=…&name=…`: the people each name finds in every contact book and mailbox. */
export function handlePeopleRoute(request: AuthenticatedRequest): Promise<Result<PeopleAnswer, ApiError>> {
	return Do(async ($) => {
		const {name: names} = $(parseSchema(querySchema, request.query));
		const orgId = $(await requireUserOrgId(request));
		const books = $(await findSources(orgId, 'contacts', 'list'));
		const mailboxes = searchable($(await findSources(orgId, 'emails', 'list')));
		const wanted = [...new Set(names)].slice(0, 10);
		const searched = await Promise.all(
			wanted.map(async (name) => {
				const [inBooks, inEmail] = await Promise.all([
					eachSource(books, (source) => searchContacts(source, name)),
					eachSource(mailboxes, (source) =>
						source
							.find(source, {from: null, involving: name, words: [], since: null}, EMAILS_READ)
							.then((found) => found.map((records) => peopleInEmails(source.connection.id, source.connection.account, records, name))),
					),
				]);
				return {people: [...inBooks.found, ...inEmail.found].flatMap(({value}) => value), failed: [...inBooks.failed, ...inEmail.failed]};
			}),
		);
		const failed = new Map(searched.flatMap((one) => one.failed.map((failure): [string, Failure] => [failure.connectionId, failure])));
		const sources = new Map([...books, ...mailboxes].map((source): [string, SourceSummary] => [source.connection.id, summarize(source)]));
		return {
			sources: [...sources.values()],
			people: wanted.map((name, index) => ({name, matches: rankPeople(searched[index]?.people ?? [], name)})),
			failed: [...failed.values()],
		};
	});
}
