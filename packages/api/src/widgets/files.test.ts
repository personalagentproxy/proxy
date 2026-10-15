import {describe, expect, test} from 'bun:test';

import {gmailQuery} from '../records/email-search';
import {driveQuery, rankFiles} from './files';

describe('the searches in each provider’s terms', () => {
	test("Drive's: every word in the name, or in the text, the owner, never what is trashed, quotes escaped; the kind no filter", () => {
		const search = {words: ['q3', "paul's"], kind: 'Presentation' as const, owner: 'paul@example.com'};
		expect(driveQuery(search, 'name')).toBe("name contains 'q3' and name contains 'paul\\'s' and 'paul@example.com' in owners and trashed = false");
		expect(driveQuery(search, 'content')).toBe("fullText contains 'q3' and fullText contains 'paul\\'s' and 'paul@example.com' in owners and trashed = false");
		expect(driveQuery({words: [], kind: null, owner: null}, 'name')).toBe('trashed = false');
	});

	test('puts files of the kind said first, then those named so, then the most recently changed', () => {
		const file = (id: string, kind: string, matched: 'name' | 'content', modified: string) => ({connectionId: 'g', id, name: id, kind, owner: '', modified, link: null, matched});
		const files = [
			file('new-sheet', 'Spreadsheet', 'name', '2026-10-12T00:00:00Z'),
			file('old-doc', 'Document', 'name', '2026-01-01T00:00:00Z'),
			file('mentions-it', 'Document', 'content', '2026-10-14T00:00:00Z'),
			file('newer-sheet', 'Spreadsheet', 'name', '2026-10-13T00:00:00Z'),
		];
		expect(rankFiles(files, 'Document').map((one) => one.id)).toEqual(['old-doc', 'mentions-it', 'newer-sheet', 'new-sheet']);
		expect(rankFiles(files, null).map((one) => one.id)).toEqual(['newer-sheet', 'new-sheet', 'old-doc', 'mentions-it']);
	});

	test("Gmail's: the sender, quoted where it has spaces, the words, and the day as Gmail writes it", () => {
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
