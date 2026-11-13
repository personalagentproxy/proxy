import {describe, expect, test} from 'bun:test';

import {parsePreview, previewable} from './preview';

const PAGE = new URL('https://www.example.com/blog/post');

describe('parsePreview', () => {
	test('reads Open Graph tags first', () => {
		const preview = parsePreview(
			`<head><title>Plain</title><meta name="description" content="Plain words">
			<meta property="og:title" content="Fish &amp; Chips"><meta property="og:description" content="Tasty">
			<meta property="og:site_name" content="Chippy"><meta property="og:image" content="/pic.png"></head>`,
			PAGE,
		);
		expect(preview).toEqual({
			url: 'https://www.example.com/blog/post',
			title: 'Fish & Chips',
			description: 'Tasty',
			siteName: 'Chippy',
			image: 'https://www.example.com/pic.png',
		});
	});

	test('falls back to the plain tags and the host', () => {
		const preview = parsePreview('<title>\n Hello   there </title><meta name="description" content="Words">', PAGE);
		expect(preview.title).toBe('Hello there');
		expect(preview.description).toBe('Words');
		expect(preview.siteName).toBe('example.com');
		expect(preview.image).toBeNull();
	});

	test('drops pictures that are not https', () => {
		expect(parsePreview('<meta property="og:image" content="http://example.com/a.png">', PAGE).image).toBeNull();
		expect(parsePreview('<meta property="og:image" content="javascript:alert(1)">', PAGE).image).toBeNull();
	});
});

describe('previewable', () => {
	test('takes only https addresses without a sign-in', () => {
		expect(previewable('https://example.com/a')?.hostname).toBe('example.com');
		expect(previewable('http://example.com')).toBeNull();
		expect(previewable('https://user:pass@example.com')).toBeNull();
		expect(previewable('not a url')).toBeNull();
		expect(previewable(undefined)).toBeNull();
	});
});

