/// <reference types="bun" />

import {describe, expect, test} from 'bun:test';
import type {Intent} from '@/client/intent-client';
import type {People, Person} from '@/client/widgets-client';
import {
	aboutPhrase,
	bestMatch,
	emailQuery,
	eventTime,
	fileSearch,
	isAddress,
	matchesFor,
	namesIn,
	senderName,
	termsRead,
} from '@/lib/widget-values';

// Wednesday 14 October 2026, 14:30 local time.
const now = new Date(2026, 9, 14, 14, 30);

function intentWith(widget: string, fields: Record<string, string[]>): Intent {
	return {
		widget,
		fields: Object.entries(fields).map(([id, values]) => ({id, name: id, values})),
		ms: 0,
	};
}

function person(name: string, email: string): Person {
	return {
		origin: 'contacts',
		connectionId: 'c1',
		id: name,
		name,
		emails: [email],
		phones: [],
		company: '',
		jobTitle: '',
		addresses: [],
		link: null,
	};
}

describe('people', () => {
	const people: People = {
		sources: [],
		people: [
			{
				name: 'jacky',
				matches: [person('Jacky Doe', 'jacky@example.com'), person('Jacky Chen', 'jc@example.com')],
			},
		],
		failed: [],
	};

	test('takes the closest the contact books found for a name, as typed with spaces around it', () => {
		expect(bestMatch(people, ' jacky ')?.emails).toEqual(['jacky@example.com']);
		expect(matchesFor(people, 'jacky')).toHaveLength(2);
		expect(bestMatch(people, 'nobody')).toBeNull();
		expect(bestMatch(null, 'jacky')).toBeNull();
	});

	test('parts names a model took for one person', () => {
		const intent = intentWith('write_email', {
			to: ['jon and jacky', 'Sam, Rita & Hugo', 'Alexandra'],
		});
		expect(namesIn(intent, 'to')).toEqual(['jon', 'jacky', 'Sam', 'Rita', 'Hugo', 'Alexandra']);
	});

	test('reads what an email is about from what follows "about"', () => {
		expect(aboutPhrase('email jon and jacky about lunch next week')).toBe('lunch next week');
		expect(aboutPhrase('write to sam regarding the q3 budget')).toBe('the q3 budget');
		expect(aboutPhrase('email jon')).toBeNull();
	});

	test('takes an address as it is typed', () => {
		expect(isAddress('sam@example.com')).toBe(true);
		expect(isAddress('sam')).toBe(false);
	});
});

describe('eventTime', () => {
	test('reads the time from all that was typed, half an hour long', () => {
		const time = eventTime('book a meeting with caleb tomorrow at 3pm', now);
		expect(time?.start).toEqual(new Date(2026, 9, 15, 15, 0));
		expect(time?.end).toEqual(new Date(2026, 9, 15, 15, 30));
		expect(time?.hourGuessed).toBe(false);
	});

	test('takes an hour from 1 to 7 without am or pm for the afternoon, and one from 8 to 12 as said', () => {
		expect(eventTime('create an event tomorrow at 2', now)?.start).toEqual(
			new Date(2026, 9, 15, 14, 0),
		);
		expect(eventTime('call with paul at 9 tomorrow', now)?.start).toEqual(
			new Date(2026, 9, 15, 9, 0),
		);
		expect(eventTime('lunch with jacky friday at 12', now)?.start).toEqual(
			new Date(2026, 9, 16, 12, 0),
		);
		expect(eventTime('meet jon on monday at 3:30', now)?.start).toEqual(
			new Date(2026, 9, 19, 15, 30),
		);
		expect(eventTime('standup at 2am tomorrow', now)?.start).toEqual(new Date(2026, 9, 15, 2, 0));
	});

	test('puts together a day and an hour said apart', () => {
		expect(eventTime('meet jon on friday about the launch at 3', now)?.start).toEqual(
			new Date(2026, 9, 16, 15, 0),
		);
	});

	test('a time without a day is the next to come', () => {
		// It is half past two: 2 PM has passed today.
		expect(eventTime('coffee with sam at 2', now)?.start).toEqual(new Date(2026, 9, 15, 14, 0));
		expect(eventTime('coffee with sam at 4', now)?.start).toEqual(new Date(2026, 9, 14, 16, 0));
	});

	test('puts a meeting with only a day at 10:00, and keeps an end that was said', () => {
		expect(eventTime('sync on friday', now)?.start).toEqual(new Date(2026, 9, 16, 10, 0));
		expect(eventTime('sync on friday', now)?.hourGuessed).toBe(true);
		expect(eventTime('workshop tomorrow from 2 to 4', now)?.end).toEqual(
			new Date(2026, 9, 15, 16, 0),
		);
	});

	test('is nothing without a time', () => {
		expect(eventTime('book a meeting with jon', now)).toBeNull();
	});
});

describe('emails', () => {
	test("searches from the sender as written, about the model's terms, since the day it goes back to", () => {
		const query = emailQuery(
			intentWith('find_email', {from: ['sam'], about: ['invoice | bill']}),
			'emails from sam about the invoice last week',
			now,
		);
		expect(query).toEqual({from: 'sam', words: ['invoice | bill'], since: '2026-10-07'});
		expect(termsRead(['flight | itinerary | booking', 'SFO | San Francisco'])).toBe('flight, SFO');
	});

	test('goes back to the last of a day said alone, and to none still to come or that the email is about', () => {
		const since = (typed: string) => emailQuery(intentWith('find_email', {}), typed, now).since;

		expect(since('emails from jon on friday')).toBe('2026-10-09');
		expect(since('emails since monday')).toBe('2026-10-12');
		expect(since('emails from december')).toBe('2025-12-01');
		expect(since('emails from yesterday')).toBe('2026-10-13');
		expect(since('find the email about my flight tomorrow')).toBeNull();
		expect(since('the email about the 3pm call')).toBeNull();
		expect(since("the invite for monday's meeting")).toBeNull();
		expect(since('the invite for friday’s offsite, sent yesterday')).toBe('2026-10-13');
	});

	test('searches everything without a sender, a topic or a day', () => {
		expect(emailQuery(intentWith('find_email', {}), 'find my email', now)).toEqual({
			from: null,
			words: [],
			since: null,
		});
	});

	test('names a sender by the name in their address, or the address alone', () => {
		expect(senderName('Sam Lee <sam@example.com>')).toBe('Sam Lee');
		expect(senderName('"Uber Receipts" <noreply@uber.com>')).toBe('Uber Receipts');
		expect(senderName('noreply@uber.com')).toBe('noreply@uber.com');
	});
});

describe('files', () => {
	test('takes the kind and the owner out of the name, and searches for the rest', () => {
		const search = fileSearch(
			intentWith('find_file', {name: ['pricing spreadsheet'], owner: ['paul']}),
			'',
		);
		expect(search).toEqual({words: ['pricing'], kind: 'Spreadsheet', ownerName: 'paul'});
	});

	test('searches for what was typed when no name was found, without filler', () => {
		const search = fileSearch(intentWith('find_file', {}), 'where is the q3 board deck');
		expect(search).toEqual({words: ['q3', 'board'], kind: 'Presentation', ownerName: null});
	});
});
