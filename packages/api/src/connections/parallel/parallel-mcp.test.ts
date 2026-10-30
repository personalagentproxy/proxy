import {describe, expect, test} from 'bun:test';

import {formatParallelResults, parseParallelPage} from './parallel-mcp';

describe('formatParallelResults', () => {
	test('writes the results out as Exa writes its own, a block a page', () => {
		const text = JSON.stringify({
			search_id: 'search_1',
			results: [
				{url: 'https://bun.sh/docs/test/mocks', title: 'Mocks | Bun Docs', publish_date: '2026-10-12', excerpts: ['Mocking replaces a dependency.', 'Use mock.module.']},
				{url: 'https://example.com', title: null, publish_date: null, excerpts: ['Example Domain']},
			],
			warnings: [],
		});
		expect(formatParallelResults(text).unwrap()).toBe(
			[
				'Title: Mocks | Bun Docs\nURL: https://bun.sh/docs/test/mocks\nPublished: 2026-10-12\nHighlights:\nMocking replaces a dependency.\n...\nUse mock.module.',
				'Title: https://example.com\nURL: https://example.com\nPublished: N/A\nHighlights:\nExample Domain',
			].join('\n\n---\n\n'),
		);
	});

	test('is Parallel out of reach when it answers with something else', () => {
		expect(formatParallelResults('Rate limited').unwrapErr().kind).toBe('provider_unreachable');
	});
});

describe('parseParallelPage', () => {
	test('reads the page in full', () => {
		const text = JSON.stringify({
			results: [{url: 'https://example.com', title: 'Example Domain', excerpts: ['Example'], full_content: '# Example Domain\n\nThis domain is for examples.\n'}],
			errors: [],
		});
		expect(parseParallelPage(text, 'https://example.com').unwrap()).toEqual({title: 'Example Domain', content: '# Example Domain\n\nThis domain is for examples.'});
	});

	const failed = (url: string, error_type: string, http_status_code: number | null) =>
		parseParallelPage(JSON.stringify({results: [], errors: [{url, error_type, http_status_code, content: null}]}), url).unwrapErr();

	test('a page the site has no longer, or turned the crawler away from, fails as Exa’s do, by the site’s status', () => {
		expect(failed('https://example.com/gone', 'http_error', 404)).toMatchObject({
			kind: 'not_found',
			resource: 'page',
			id: 'https://example.com/gone',
			message: expect.stringContaining('Parallel found no page at https://example.com/gone'),
		});
		expect(failed('https://example.com/members', 'http_error', 403)).toMatchObject({
			kind: 'validation_error',
			message: expect.stringContaining('turned Parallel’s crawler away (HTTP 403)'),
		});
		expect(failed('https://example.com/down', 'http_error', 502)).toMatchObject({kind: 'provider_unreachable', cause: {status: 502}});
	});

	test("says why Parallel couldn't read the page, in its words, for any other failure", () => {
		expect(failed('https://nowhere.example', 'connect_error', null)).toMatchObject({kind: 'validation_error', message: 'Parallel couldn’t read https://nowhere.example: connect_error'});
		expect(failed('https://example.com/odd', 'http_error', 418)).toMatchObject({kind: 'validation_error', message: 'Parallel couldn’t read https://example.com/odd: http_error (HTTP 418)'});
	});
});
