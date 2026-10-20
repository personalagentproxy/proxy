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

	test("says why Parallel couldn't read the page", () => {
		const text = JSON.stringify({results: [], errors: [{url: 'https://example.com/gone', error_type: 'fetch_error', http_status_code: 404, content: null}]});
		const error = parseParallelPage(text, 'https://example.com/gone').unwrapErr();
		expect(error).toMatchObject({kind: 'validation_error', message: 'Parallel couldn’t read https://example.com/gone: fetch_error (HTTP 404)'});
	});
});
