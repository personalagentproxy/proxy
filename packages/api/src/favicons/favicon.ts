import {Err, Ok, Result} from 'ts-results-es';
import {getDomain} from 'tldts';

import {Do, type FetchError} from '@proxy/utils';

import {checkedRequest} from '../utils/checked-request';

/**
 * The icon of a custom MCP server's site, for its connection's logo: the one the home page of its
 * main domain names, `mcp.sentry.dev` being `sentry.dev`'s, else that domain's `/favicon.ico`.
 * Every request goes through `checkedRequest`, each redirect checked again before it is followed,
 * so a domain can't point the api at its own network. What is found, or that nothing was, is kept
 * for every person alike.
 */

const TIMEOUT_MS = 5000;
const MAX_REDIRECTS = 3;
const PAGE_MAX_BYTES = 1_000_000;
const ICON_MAX_BYTES = 256_000;
// The icons a page names that are tried before `/favicon.ico`, best first.
const MAX_CANDIDATES = 3;

const KEEP_MS = 24 * 60 * 60 * 1000;
// A domain with no icon may get one, or have been out of reach for a moment.
const KEEP_MISS_MS = 60 * 60 * 1000;
const MAX_KEPT = 1000;

export type Favicon = {type: string; bytes: Uint8Array};

/**
 * A host's main domain, the one registered under its public suffix: `sentry.dev` for
 * `mcp.sentry.dev`, `acme.co.uk` for `api.acme.co.uk`, and `my.vercel.app` for an app hosted
 * there. Null for an address or a name such as `localhost`, which have none.
 */
export function mainDomain(host: string): string | null {
	return getDomain(host, {allowPrivateDomains: true});
}

type Fetched = {url: URL; type: string; bytes: Uint8Array};

function tooLarge(url: URL): FetchError {
	return {kind: 'parse', url: url.toString(), cause: new Error('The answer is too large')};
}

// The body, unless it runs past `maxBytes`, when reading stops there.
async function readCapped(url: URL, response: Response, maxBytes: number): Promise<Result<Uint8Array, FetchError>> {
	if (Number(response.headers.get('content-length')) > maxBytes) {
		await Result.wrapAsync(async () => response.body?.cancel());
		return Err(tooLarge(url));
	}
	const reader = response.body?.getReader();
	if (!reader) {
		return Ok(new Uint8Array());
	}
	const chunks: Uint8Array[] = [];
	let size = 0;
	for (;;) {
		const read = await Result.wrapAsync(() => reader.read());
		if (read.isErr()) {
			return Err({kind: 'network', url: url.toString(), cause: read.error});
		}
		if (read.value.done) {
			return Ok(Buffer.concat(chunks));
		}
		size += read.value.value.byteLength;
		if (size > maxBytes) {
			await Result.wrapAsync(() => reader.cancel());
			return Err(tooLarge(url));
		}
		chunks.push(read.value.value);
	}
}

// A GET that follows redirects, each one's address checked as the first was.
function get(start: URL, accept: string, maxBytes: number): Promise<Result<Fetched, FetchError>> {
	return Do(async ($) => {
		let url = start;
		for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
			const response = $(
				await checkedRequest(url.toString(), {method: 'GET', redirect: 'manual', headers: {accept}}, {parse: 'response', timeoutMs: TIMEOUT_MS, allowStatus: (status) => status < 400}),
			);
			if (response.status < 300) {
				const bytes = $(await readCapped(url, response, maxBytes));
				return {url, type: response.headers.get('content-type') ?? '', bytes};
			}
			await Result.wrapAsync(async () => response.body?.cancel());
			const location = response.headers.get('location');
			if (location === null || !URL.canParse(location, url)) {
				return $(Err<FetchError>({kind: 'http', url: url.toString(), status: response.status, body: 'A redirect to nowhere'}));
			}
			url = new URL(location, url);
		}
		return $(Err<FetchError>({kind: 'network', url: start.toString(), cause: new Error('Too many redirects')}));
	});
}

// An attribute of a tag as written, in any of its quotings.
function attribute(tag: string, name: string): string | null {
	const match = new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'>]+))`, 'i').exec(tag);
	if (!match) {
		return null;
	}
	return match[1] ?? match[2] ?? match[3] ?? null;
}

// How good an icon is to show small and sharp: a drawing beats any picture, and a larger picture a
// smaller one. An Apple touch icon, often a padded tile of its own, only beats nothing.
function rank(rel: string[], href: string, type: string | null, sizes: string | null): number {
	if (!rel.includes('icon')) {
		return 0;
	}
	if (type === 'image/svg+xml' || /\.svg(\?|$)/i.test(href)) {
		return Number.MAX_SAFE_INTEGER;
	}
	const largest = Math.max(0, ...(sizes ?? '').split(/\s+/).map((size) => Number.parseInt(size, 10) || 0));
	return largest || 32;
}

/** The icons a page names in its `<link rel="icon">` tags and the like, as addresses, best first. */
export function iconLinks(html: string, page: URL): URL[] {
	const icons: {url: URL; rank: number}[] = [];
	for (const [tag] of html.matchAll(/<link\b[^>]*>/gi)) {
		const rel = (attribute(tag, 'rel') ?? '').toLowerCase().split(/\s+/);
		const href = attribute(tag, 'href')?.replaceAll('&amp;', '&').trim();
		if (!href || !(rel.includes('icon') || rel.includes('apple-touch-icon')) || !URL.canParse(href, page)) {
			continue;
		}
		const url = new URL(href, page);
		if (url.protocol !== 'https:' && url.protocol !== 'http:') {
			continue;
		}
		icons.push({url, rank: rank(rel, href, attribute(tag, 'type'), attribute(tag, 'sizes'))});
	}
	return icons.sort((a, b) => b.rank - a.rank).map((icon) => icon.url);
}

async function fetchIcon(url: URL): Promise<Favicon | null> {
	const fetched = await get(url, 'image/*', ICON_MAX_BYTES);
	if (fetched.isErr() || !fetched.value.type.startsWith('image/') || fetched.value.bytes.byteLength === 0) {
		return null;
	}
	return {type: fetched.value.type, bytes: fetched.value.bytes};
}

async function findFavicon(domain: string): Promise<Favicon | null> {
	const home = new URL(`https://${domain}/`);
	const page = await get(home, 'text/html', PAGE_MAX_BYTES);
	const named = page.isOk() ? iconLinks(new TextDecoder().decode(page.value.bytes), page.value.url) : [];
	for (const url of [...named.slice(0, MAX_CANDIDATES), new URL('/favicon.ico', home)]) {
		const icon = await fetchIcon(url);
		if (icon) {
			return icon;
		}
	}
	return null;
}

const kept = new Map<string, {at: number; favicon: Favicon | null}>();

/** The icon of a domain's site, found once a day at most; null where it has none to be found. */
export async function faviconOf(domain: string): Promise<Favicon | null> {
	const known = kept.get(domain);
	if (known && Date.now() - known.at < (known.favicon ? KEEP_MS : KEEP_MISS_MS)) {
		return known.favicon;
	}
	const favicon = await findFavicon(domain);
	kept.delete(domain);
	kept.set(domain, {at: Date.now(), favicon});
	// The domain kept longest ago goes first: a Map keeps the order its keys were set in.
	const [oldest] = kept.keys();
	if (kept.size > MAX_KEPT && oldest !== undefined) {
		kept.delete(oldest);
	}
	return favicon;
}
