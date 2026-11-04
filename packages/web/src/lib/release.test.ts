/// <reference types="bun" />

import {describe, expect, test} from 'bun:test';
import {bundleOf, currentBundle, hasNewRelease, type FetchPage} from '@/lib/release';

const BUILT = `<!doctype html><html><head>
<script>let savedTheme = null;</script>
<script type="module" crossorigin src="/assets/index-C3kN2xYz.js"></script>
<link rel="stylesheet" crossorigin href="/assets/index-Dq1a2b3c.css">
</head><body><div id="root"></div></body></html>`;

function page(html: string, options: {status?: number; type?: string} = {}): FetchPage {
	return () =>
		Promise.resolve(
			new Response(html, {
				status: options.status ?? 200,
				headers: {'content-type': options.type ?? 'text/html; charset=utf-8'},
			}),
		);
}

function documentWith(bundle: string | null): Document {
	const doc = document.implementation.createHTMLDocument();
	if (bundle) {
		const script = doc.createElement('script');
		script.setAttribute('type', 'module');
		script.setAttribute('src', bundle);
		doc.head.appendChild(script);
	}
	return doc;
}

describe('bundleOf', () => {
	test('names the module script of a build, past the inline one', () => {
		expect(bundleOf(BUILT)).toBe('/assets/index-C3kN2xYz.js');
	});

	test('names the development entry', () => {
		expect(bundleOf('<script type="module" src="/src/main.tsx"></script>')).toBe('/src/main.tsx');
	});

	test('is null for a page without a module script', () => {
		expect(bundleOf('<html><body>Service unavailable</body></html>')).toBeNull();
		expect(bundleOf('<script src="/legacy.js"></script>')).toBeNull();
	});
});

describe('currentBundle', () => {
	test('reads the page its own module script', () => {
		expect(currentBundle(documentWith('/assets/index-A.js'))).toBe('/assets/index-A.js');
		expect(currentBundle(documentWith(null))).toBeNull();
	});
});

describe('hasNewRelease', () => {
	test('is true when the server names another bundle', async () => {
		expect(await hasNewRelease(documentWith('/assets/index-Old.js'), page(BUILT))).toBe(true);
	});

	test('is false when the server names the same bundle', async () => {
		expect(await hasNewRelease(documentWith('/assets/index-C3kN2xYz.js'), page(BUILT))).toBe(false);
	});

	test('is false on an error page, a non-page or a failed request', async () => {
		const doc = documentWith('/assets/index-Old.js');
		expect(await hasNewRelease(doc, page('<html>Bad gateway</html>', {status: 502}))).toBe(false);
		expect(await hasNewRelease(doc, page('{"ok":true}', {type: 'application/json'}))).toBe(false);
		expect(await hasNewRelease(doc, page('<html><body>Maintenance</body></html>'))).toBe(false);
		expect(await hasNewRelease(doc, () => Promise.reject(new TypeError('Failed to fetch')))).toBe(
			false,
		);
	});

	test('is false for a page without a bundle of its own', async () => {
		expect(await hasNewRelease(documentWith(null), page(BUILT))).toBe(false);
	});
});
