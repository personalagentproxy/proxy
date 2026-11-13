import {describe, expect, test} from 'bun:test';

import {formatYoucomResults, parseYoucomPage, YOUCOM} from './youcom-mcp';

describe('formatYoucomResults', () => {
	test('writes the results out as Exa writes its own, a block a page, web first and then news', () => {
		const text = JSON.stringify({
			results: {
				web: [
					{
						url: 'https://bun.sh/docs/test/mocks',
						title: 'Mocks | Bun Docs',
						description: 'Mocks',
						page_age: '2026-10-12T00:00:00',
						contents: {highlights: ['Mocking replaces a dependency.', 'Use mock.module.']},
					},
					{url: 'https://example.com', title: '', description: 'Example Domain', snippets: []},
					{title: 'No address'},
				],
				news: [{url: 'https://news.example.com/a', title: 'Bun 2', description: 'Bun ships mocks', page_age: null}],
			},
			metadata: {search_uuid: 'uuid-1'},
		});
		expect(formatYoucomResults(text).unwrap()).toBe(
			[
				'Title: Mocks | Bun Docs\nURL: https://bun.sh/docs/test/mocks\nPublished: 2026-10-12\nHighlights:\nMocking replaces a dependency.\n...\nUse mock.module.',
				'Title: https://example.com\nURL: https://example.com\nPublished: N/A\nHighlights:\nExample Domain',
				'Title: Bun 2\nURL: https://news.example.com/a\nPublished: N/A\nHighlights:\nBun ships mocks',
			].join('\n\n---\n\n'),
		);
	});

	test('uses snippets where You.com gave no highlights', () => {
		const text = JSON.stringify({results: {web: [{url: 'https://a.example', title: 'A', description: 'd', snippets: ['one', 'two']}]}});
		expect(formatYoucomResults(text).unwrap()).toBe('Title: A\nURL: https://a.example\nPublished: N/A\nHighlights:\none\n...\ntwo');
	});

	test('no results is an empty answer', () => {
		expect(formatYoucomResults(JSON.stringify({results: {}})).unwrap()).toBe('');
	});

	test('is You.com out of reach when it answers with something else', () => {
		expect(formatYoucomResults('Rate limited').unwrapErr().kind).toBe('provider_unreachable');
	});
});

describe('parseYoucomPage', () => {
	test('reads the page asked for as Markdown, matched by address', () => {
		const text = JSON.stringify({
			output: [
				{url: 'https://other.example', title: 'Other', markdown: 'other'},
				{url: 'https://example.com', title: 'Example Domain', markdown: '# Example Domain\n\nThis domain is for examples.\n'},
			],
		});
		expect(parseYoucomPage(text, 'https://example.com').unwrap()).toEqual({title: 'Example Domain', content: '# Example Domain\n\nThis domain is for examples.'});
	});

	test('takes the one entry where You.com wrote the address another way, and a bare array', () => {
		const text = JSON.stringify([{url: 'https://example.com/', title: 'Example', markdown: 'text'}]);
		expect(parseYoucomPage(text, 'https://example.com').unwrap()).toEqual({title: 'Example', content: 'text'});
	});

	test('no Markdown is no text', () => {
		expect(parseYoucomPage(JSON.stringify({output: [{url: 'https://example.com', markdown: null}]}), 'https://example.com').unwrap()).toEqual({title: '', content: ''});
	});
});

describe('YOUCOM', () => {
	test('a key You.com turns down is the credential rejected', () => {
		expect(YOUCOM.toolError?.('Error: Authentication failed: Invalid or expired API key. Please check your You.com API key.')?.kind).toBe('credentials_rejected');
		expect(YOUCOM.toolError?.('Error: Failed to perform search. Error code: 401')?.kind).toBe('credentials_rejected');
	});

	test('any other failure is in its own words', () => {
		expect(YOUCOM.toolError?.('Error: Query too long')).toMatchObject({kind: 'validation_error', message: 'You.com turned it down: Query too long'});
	});

	test('names this integration in its User-Agent, on You.com requests only', () => {
		expect(YOUCOM.headers).toEqual({'user-agent': 'youdotcom-integration/personalagentproxy-proxy'});
	});
});
