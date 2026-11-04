import {Err, Ok, type Result} from 'ts-results-es';

// Which release of the web app a page is: the module script index.html loads. A build's is
// named by its content by Vite (/assets/index-<hash>.js), so a page whose script is not the one
// the server's index.html names now is an older release. In development it is /src/main.tsx,
// which never changes.

const SCRIPT_TAG = /<script\b[^>]*>/gi;
const TYPE_MODULE = /\btype\s*=\s*["']?module["']?/i;
const SRC = /\bsrc\s*=\s*["']([^"']+)["']/i;

// The module script's `src` in a page's HTML; null without one.
export function bundleOf(html: string): string | null {
	for (const [tag] of html.matchAll(SCRIPT_TAG)) {
		if (!TYPE_MODULE.test(tag)) {
			continue;
		}

		const src = SRC.exec(tag)?.[1];
		if (src) {
			return src;
		}
	}

	return null;
}

// The bundle the page in front of the person was loaded with.
export function currentBundle(doc: Document): string | null {
	return doc.querySelector('script[type="module"][src]')?.getAttribute('src') ?? null;
}

// A `fetch`: the browser's, or a test's.
export type FetchPage = (input: string, init?: RequestInit) => Promise<Response>;

// The bundle the server names now, from its index.html, never from a cache. Anything but a page
// of the app, as a proxy's error page would be, is an error and no verdict.
export async function fetchServerBundle(
	fetchFn: FetchPage = fetch,
): Promise<Result<string, Error>> {
	const response = await fetchFn('/', {
		cache: 'no-store',
		headers: {Accept: 'text/html'},
	}).catch((error: unknown) => (error instanceof Error ? error : new Error(String(error))));
	if (response instanceof Error) {
		return Err(response);
	}

	if (!response.ok || !response.headers.get('content-type')?.includes('text/html')) {
		return Err(new Error(`Unexpected response for index.html: ${response.status}`));
	}

	const bundle = bundleOf(await response.text());
	if (!bundle) {
		return Err(new Error('No module script in index.html'));
	}

	return Ok(bundle);
}

// Whether the server has a newer release than the page: an error, or a page without a bundle of
// its own, is no.
export async function hasNewRelease(doc: Document, fetchFn: FetchPage = fetch): Promise<boolean> {
	const current = currentBundle(doc);
	if (!current) {
		return false;
	}

	const server = await fetchServerBundle(fetchFn);
	if (server.isErr()) {
		return false;
	}

	return server.value !== current;
}
