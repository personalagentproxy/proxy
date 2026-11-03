import {describe, expect, test} from 'bun:test';

import {ApiErr} from '@proxy/utils';

import {EXA, parseExaPage} from './exa-mcp';

describe('parseExaPage', () => {
	test("reads the title from the heading Exa puts before a page's text", () => {
		const text = '# Mocks | Bun Docs\nURL: https://bun.sh/docs/test/mocks\n\n# Mocks\n\nMocking replaces a dependency.\n';
		expect(parseExaPage(text)).toEqual({title: 'Mocks | Bun Docs', content: '# Mocks\n\nMocking replaces a dependency.'});
	});

	test('keeps all of it as the text when there is no heading', () => {
		expect(parseExaPage('Just text\n')).toEqual({title: '', content: 'Just text'});
	});

	test('has no text where Exa found nothing and had no code for why', () => {
		expect(parseExaPage('No content found for the provided URL(s).')).toEqual({title: '', content: ''});
	});
});

describe('EXA.toolError', () => {
	const toolError = (text: string) => EXA.toolError?.(text);
	const page = (url: string, code: string) => toolError(`Error fetching URL(s): ${url}: ${code}`);

	test('a page Exa found nothing at is not found, with its address and what to do next', () => {
		const error = page('https://example.com/docs/old-guide', 'CRAWL_NOT_FOUND');

		expect(error).toMatchObject({kind: 'not_found', resource: 'page', id: 'https://example.com/docs/old-guide'});
		expect(error && 'message' in error ? error.message : '').toBe(
			'Exa found no page at https://example.com/docs/old-guide: it may have moved or been taken down, or Exa’s crawler may not reach it. Search for its current address with searches_run, or read the same content at another address, such as a file’s raw address instead of its page, or the other way round.',
		);
		expect(page('https://example.com/gone', 'CRAWL_HTTP_404')).toMatchObject({kind: 'not_found'});
	});

	test('a site that turned the crawler away, a page with no text or one that isn’t text, is turned down, saying trying again won’t help', () => {
		expect(page('https://example.com/members/report', 'CRAWL_HTTP_403')).toEqual(
			ApiErr.validationError(
				'https://example.com/members/report turned Exa’s crawler away (HTTP 403): the site needs a sign-in or blocks crawlers. Trying again won’t help: find the same content at another address with searches_run, or ask the person for it.',
			),
		);
		expect(page('https://example.com/members/report', 'CRAWL_HTTP_401')).toMatchObject({kind: 'validation_error', message: expect.stringContaining('(HTTP 401)')});
		expect(page('https://app.example.com/dashboard', 'CRAWL_EMPTY_CONTENT')).toMatchObject({
			kind: 'validation_error',
			message: expect.stringContaining('Exa found no text at https://app.example.com/dashboard: the page may be empty, or built by JavaScript'),
		});
		expect(page('https://example.com/logo.png', 'CRAWL_UNEXPECTED_CONTENT_TYPE')).toMatchObject({
			kind: 'validation_error',
			message: expect.stringContaining('Exa can’t read https://example.com/logo.png: it answered with a type of content'),
		});
	});

	test('a slow, busy or failing site is out of reach for now, saying to try again later', () => {
		expect(page('https://example.com/slow', 'CRAWL_LIVECRAWL_TIMEOUT')).toMatchObject({
			kind: 'provider_unreachable',
			message:
				'Exa timed out reading https://example.com/slow: the site was too slow to answer. Try again in a few minutes, or find the same content at another address with searches_run, or ask the person for it.',
		});
		expect(page('https://example.com/busy', 'CRAWL_HTTP_429')).toMatchObject({kind: 'provider_unreachable', cause: {kind: 'http', status: 429}, message: expect.stringContaining('too many requests')});
		expect(page('https://example.com/down', 'CRAWL_HTTP_503')).toMatchObject({
			kind: 'provider_unreachable',
			cause: {kind: 'http', status: 503},
			message: expect.stringContaining('Try again in a few minutes'),
		});
	});

	test('a code it doesn’t know, or another failure, is in Exa’s words; a key Exa turns down, rejected', () => {
		expect(page('https://nowhere.example', 'CRAWL_UNKNOWN_ERROR')).toEqual(ApiErr.validationError('Exa turned it down: Error fetching URL(s): https://nowhere.example: CRAWL_UNKNOWN_ERROR'));
		expect(page('https://example.com/odd', 'CRAWL_HTTP_418')).toMatchObject({kind: 'validation_error'});
		expect(toolError('Error fetching URL(s): https://example.com/odd: unknown error')).toMatchObject({kind: 'validation_error'});
		expect(toolError('web_search_exa error (401): Invalid API key.')).toEqual(ApiErr.credentialsRejected());
	});
});
