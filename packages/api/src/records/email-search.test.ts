import {describe, expect, test} from 'bun:test';

import {gmailQuery} from './email-search';

describe('gmailQuery', () => {
	test('the sender, quoted where it has spaces, the words, and the day as Gmail writes it', () => {
		expect(gmailQuery({from: 'Sam Lee', words: [['invoice'], ['q3 report']], since: '2026-10-07'})).toBe('from:"Sam Lee" invoice "q3 report" after:2026/10/07');
		expect(
			gmailQuery({
				from: null,
				words: [
					['flight', 'itinerary', 'e-ticket'],
					['SFO', 'San Francisco'],
				],
				since: null,
			}),
		).toBe('(flight OR itinerary OR e-ticket) (SFO OR "San Francisco")');
		expect(gmailQuery({from: 'sam@example.com', words: [], since: null})).toBe('from:sam@example.com');
		expect(gmailQuery({from: null, words: [], since: null})).toBe('');
		expect(gmailQuery({from: null, involving: 'Jacky Doe', words: [], since: null})).toBe('{from:"Jacky Doe" to:"Jacky Doe" cc:"Jacky Doe"}');
	});
});
