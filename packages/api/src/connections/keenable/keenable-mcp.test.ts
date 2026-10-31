import {describe, expect, test} from 'bun:test';

import {ApiErr} from '@proxy/utils';

import {formatKeenableResults, KEENABLE, parseKeenablePage} from './keenable-mcp';

describe('formatKeenableResults', () => {
	test('writes the results out as Exa writes its own, a block a page, its snippet as the highlights', () => {
		const text = JSON.stringify({
			query: 'bun module mocks',
			results: [
				{
					url: 'https://bun.sh/docs/test/mocks',
					title: 'Mocks | Bun Docs',
					description: '',
					snippet: 'Mocking replaces a dependency.\nUse mock.module.\n',
					published_at: '2026-10-12T08:00:00Z',
					acquired_at: '2026-10-13T09:00:00Z',
				},
				{url: 'https://example.com', title: '', description: '', snippet: 'Example Domain', acquired_at: '2026-10-13T09:00:00Z'},
			],
		});
		expect(formatKeenableResults(text).unwrap()).toBe(
			[
				'Title: Mocks | Bun Docs\nURL: https://bun.sh/docs/test/mocks\nPublished: 2026-10-12\nHighlights:\nMocking replaces a dependency.\nUse mock.module.',
				'Title: https://example.com\nURL: https://example.com\nPublished: N/A\nHighlights:\nExample Domain',
			].join('\n\n---\n\n'),
		);
	});

	test('is Keenable out of reach when it answers with something else', () => {
		expect(formatKeenableResults('Rate limit exceeded').unwrapErr().kind).toBe('provider_unreachable');
	});
});

describe('parseKeenablePage', () => {
	test('reads the title and the text', () => {
		const text = JSON.stringify({url: 'https://example.com/', title: 'Example Domain', content: '# Example Domain\n\nThis domain is for examples.\n', description: ''});
		expect(parseKeenablePage(text).unwrap()).toEqual({title: 'Example Domain', content: '# Example Domain\n\nThis domain is for examples.'});
	});

	test('a page without a title keeps all of it as the text', () => {
		expect(parseKeenablePage(JSON.stringify({url: 'https://example.com/', content: 'Just text\n'})).unwrap()).toEqual({title: '', content: 'Just text'});
	});
});

describe('KEENABLE.toolError', () => {
	const toolError = (text: string) => KEENABLE.toolError?.(text);
	const page = (url: string, reason: string) => toolError(`Error fetching ${url}: ${reason}`);

	test('a page Keenable found nothing at is not found, with its address and what to do next, as Exa’s is', () => {
		expect(page('https://example.com/docs/old-guide', 'The page does not exist at this URL. Check that the URL is correct.')).toMatchObject({
			kind: 'not_found',
			resource: 'page',
			id: 'https://example.com/docs/old-guide',
			message: expect.stringContaining('Keenable found no page at https://example.com/docs/old-guide'),
		});
	});

	test('a site that turned its fetcher away for too many requests, or that it couldn’t reach, is out of reach for now', () => {
		expect(page('https://example.com/busy', 'The target server rate-limited this fetch, please retry shortly.')).toMatchObject({
			kind: 'provider_unreachable',
			cause: {kind: 'http', status: 429},
			message: expect.stringContaining('too many requests'),
		});
		expect(page('https://example.com/down', 'The target page could not be reached by the fetcher (upstream fetch failed). This may be transient — retrying is reasonable.')).toMatchObject({
			kind: 'provider_unreachable',
			message: 'Keenable couldn’t read https://example.com/down: The target page could not be reached by the fetcher (upstream fetch failed). This may be transient — retrying is reasonable.',
		});
	});

	test('any other failure is in Keenable’s words', () => {
		expect(page('https://example.com/members', 'The target server denied access to this URL')).toEqual(
			ApiErr.validationError('Keenable turned it down: Error fetching https://example.com/members: The target server denied access to this URL'),
		);
		expect(toolError('Invalid arguments')).toEqual(ApiErr.validationError('Keenable turned it down: Invalid arguments'));
	});
});
