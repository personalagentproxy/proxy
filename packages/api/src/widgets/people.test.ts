import {beforeEach, describe, expect, mock, test} from 'bun:test';
import {Err, Ok} from 'ts-results-es';

import {ApiErr} from '@proxy/utils';

const findSources = mock();
const requireUserOrgId = mock(async () => Ok('org-1'));

mock.module('./sources', () => ({findSources, summarize: (source: {connection: {id: string}}) => ({connectionId: source.connection.id})}));
// Every mailbox can be searched, with the search each fake mailbox has.
mock.module('./mail-searches', () => ({searchable: (sources: Array<{search: unknown}>) => sources.map((source) => ({...source, find: source.search}))}));
mock.module('../utils/user-org', () => ({requireUserOrgId}));

function contact(id: string, name: string, emails: string) {
	return {
		id,
		values: {name, emails, phones: '+1 555 0100', company: 'Example', jobTitle: '', addresses: 'One Boulevard Plaza\nSecond Street'},
		updatedAt: '',
		url: `https://contacts.google.com/person/${id}`,
	};
}

function source(id: string, list: (search: string) => unknown) {
	return {connection: {id, account: `${id}@example.com`, integrationId: 'google'}, connector: {list: mock(async (_target: unknown, query: {search: string}) => list(query.search))}};
}

beforeEach(() => {
	mock.clearAllMocks();
});

describe('rankPeople', () => {
	test('puts the whole name first, then its beginning, then a word beginning with it, and each person once', async () => {
		const {personOf, rankPeople} = await import('./people');
		const people = [
			personOf('a', contact('c1', 'Sam Jacky', 'sam@example.com')),
			personOf('a', contact('c2', 'Jacky Doe', 'jacky@example.com')),
			personOf('b', contact('c3', 'Jacky Doe', 'JACKY@example.com')),
			personOf('a', contact('c4', 'Jacky', 'j@example.com')),
		];
		expect(rankPeople(people, 'jacky').map((person) => [person.name, person.connectionId])).toEqual([
			['Jacky', 'a'],
			['Jacky Doe', 'a'],
			['Sam Jacky', 'a'],
		]);
	});

	test('reads a contact by the fields every contact book shares', async () => {
		const {personOf} = await import('./people');
		expect(personOf('a', contact('c1', 'Sam Lee', 'sam@example.com, s@home.example'))).toEqual({
			origin: 'contacts',
			connectionId: 'a',
			id: 'c1',
			name: 'Sam Lee',
			emails: ['sam@example.com', 's@home.example'],
			phones: ['+1 555 0100'],
			company: 'Example',
			jobTitle: '',
			addresses: ['One Boulevard Plaza', 'Second Street'],
			link: 'https://contacts.google.com/person/c1',
		});
	});
});

// An email as a mailbox search finds it: its sender, recipients and those copied, names where they were written.
function email(from: string, to: string, cc = '') {
	return {id: from, values: {from, to, cc, subject: 'Hi'}, updatedAt: ''};
}

describe('peopleInEmails', () => {
	test('takes the people close to the name from the emails, the most written first, never the account itself', async () => {
		const {peopleInEmails} = await import('./people');
		const emails = [
			email('Jacky Doe <jacky@example.com>', 'Me <me@example.com>, Sam Lee <sam@example.com>'),
			email('Me <me@example.com>', 'jacky.chen@example.com, jacky@example.com'),
			email('Me <me@example.com>', 'Jacky Chen <jacky.chen@example.com>, Jacky Doe <jacky@example.com>'),
			email('jacky@example.com', 'me@example.com'),
		];
		expect(peopleInEmails('mail', 'ME@example.com', emails, 'jacky').map((person) => [person.name, person.emails, person.origin])).toEqual([
			['Jacky Doe', ['jacky@example.com'], 'email'],
			['Jacky Chen', ['jacky.chen@example.com'], 'email'],
		]);
	});

	test('finds someone only ever copied', async () => {
		const {peopleInEmails} = await import('./people');
		const emails = [email('Sam Lee <sam@example.com>', 'me@example.com', 'Jacky Doe <jacky@example.com>, Me <me@example.com>')];
		expect(peopleInEmails('mail', 'me@example.com', emails, 'jacky').map((person) => [person.name, person.emails])).toEqual([['Jacky Doe', ['jacky@example.com']]]);
	});
});

describe('rankPeople with email', () => {
	test('a contact before someone only in email, who is the contact where the address is the same', async () => {
		const {personOf, peopleInEmails, rankPeople} = await import('./people');
		const inEmail = peopleInEmails('mail', 'me@example.com', [email('Jacky Doe <jacky@example.com>', 'me@example.com'), email('Jacky Roe <roe@example.com>', 'me@example.com')], 'jacky');
		const saved = personOf('book', contact('c1', 'Jacky Doe', 'jacky@example.com'));
		expect(rankPeople([...inEmail, saved], 'jacky').map((person) => [person.name, person.origin])).toEqual([
			['Jacky Doe', 'contacts'],
			['Jacky Roe', 'email'],
		]);
	});
});

describe('mergePeople', () => {
	test('one person for the same first and last name, or the same address, the contact leading with every address', async () => {
		const {mergePeople, personOf, peopleInEmails} = await import('./people');
		const inEmail = peopleInEmails(
			'mail',
			'me@example.com',
			[
				email('Arne Strickmann <arne@varislabs.com>', 'me@example.com'),
				email('Arne Strickmann <arne@varislabs.com>', 'me@example.com'),
				email('Arne Strickmann <arne.s@gmail.com>', 'me@example.com'),
				email('Arne Elmar Strickmann <arne.strickmann@uni.example>', 'me@example.com'),
				email('Arne <arne@other.example>', 'me@example.com'),
				email('Arne Strickmann <drive-shares-dm-noreply@google.com>', 'me@example.com'),
				email('Arne Strickmann <notifications@github.com>', 'me@example.com'),
			],
			'arne',
		);
		expect(mergePeople(inEmail).map((person) => [person.name, person.emails])).toEqual([
			['Arne Strickmann', ['arne@varislabs.com', 'arne.s@gmail.com', 'arne.strickmann@uni.example']],
			['Arne', ['arne@other.example']],
		]);

		const saved = personOf('book', contact('c1', 'Arne Strickmann', 'arne.s@gmail.com'));
		const [first] = mergePeople([...inEmail, saved]);
		expect(first).toMatchObject({origin: 'contacts', id: 'c1', name: 'Arne Strickmann', phones: ['+1 555 0100']});
		expect(first?.emails).toEqual(['arne.s@gmail.com', 'arne@varislabs.com', 'arne.strickmann@uni.example']);
	});
});

describe('handlePeopleRoute', () => {
	test('searches every contact book for each name, and says which it could not', async () => {
		const mailSearch = mock(async (_source: unknown, search: {involving: string}) => Ok(search.involving === 'hugo' ? [email('Hugo Brandt <hugo@example.com>', 'mail@example.com')] : []));
		findSources.mockImplementation(async (_orgId: string, collectionId: string) =>
			Ok(
				collectionId === 'contacts'
					? [
							source('work', (search) => Ok({records: search === 'jacky' ? [contact('c1', 'Jacky Doe', 'jacky@example.com')] : [], nextPage: null})),
							source('home', () => Err(ApiErr.credentialsRejected())),
						]
					: [{...source('mail', () => Ok({records: [], nextPage: null})), search: mailSearch}],
			),
		);
		const {handlePeopleRoute} = await import('./people');

		const answer = (await handlePeopleRoute({user: {userId: 'user-1'}, query: {name: ['jacky', ' hugo ', 'jacky']}} as never)).unwrap();
		expect(findSources).toHaveBeenCalledWith('org-1', 'contacts', 'list');
		expect(findSources).toHaveBeenCalledWith('org-1', 'emails', 'list');
		expect(mailSearch).toHaveBeenCalledWith(expect.anything(), {from: null, involving: 'hugo', words: [], since: null}, 10);
		expect(answer.sources.map((one) => one.connectionId)).toEqual(['work', 'home', 'mail']);
		expect(answer.people.map(({name, matches}) => [name, matches.map((match) => `${match.name} (${match.origin})`)])).toEqual([
			['jacky', ['Jacky Doe (contacts)']],
			['hugo', ['Hugo Brandt (email)']],
		]);
		expect(answer.failed).toEqual([{connectionId: 'home', account: 'home@example.com', message: 'its sign-in has run out: connect it again'}]);
	});
});
