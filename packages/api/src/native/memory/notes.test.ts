import {describe, expect, test} from 'bun:test';

import {isAbout, matches, nameOf, requireContent, summaryOf, titleOf, type Note} from './notes';

const note = (title: string, content: string): Note => ({id: 'note-1', title, summary: summaryOf(content), content, version: 'v1', modifiedAt: new Date('2026-11-17T10:00:00Z'), makers: []});

describe('a note', () => {
	test('is kept as its title and .md, About you by its own spelling', () => {
		expect(nameOf('  Pricing review notes ').unwrap()).toBe('Pricing review notes.md');
		expect(nameOf('about YOU').unwrap()).toBe('About you.md');
		expect(titleOf('Pricing review notes.md')).toBe('Pricing review notes');
		expect(isAbout('About you')).toBe(true);
		expect(nameOf('   ').isErr()).toBe(true);
		expect(nameOf('a'.repeat(121)).isErr()).toBe(true);
	});

	test('is summed up by its first line with words in it, without a heading’s marks', () => {
		expect(summaryOf('\n## How releases go out\n\nTag, then deploy.')).toBe('How releases go out');
		expect(summaryOf('x'.repeat(500)).length).toBe(200);
	});

	test('needs content, and no more than its title allows', () => {
		expect(requireContent('Releases', '  ').isErr()).toBe(true);
		expect(requireContent('Releases', 'x'.repeat(20_000)).isOk()).toBe(true);
		expect(requireContent('Releases', 'x'.repeat(20_001)).isErr()).toBe(true);
		expect(requireContent('About you', 'x'.repeat(3_001)).isErr()).toBe(true);
	});

	test('is found by every word of a search, in its title or its text, in any case', () => {
		const found = note('Releases', 'Tag the commit, then deploy from main.');
		expect(matches(found, 'releases DEPLOY')).toBe(true);
		expect(matches(found, 'deploy staging')).toBe(false);
	});
});
