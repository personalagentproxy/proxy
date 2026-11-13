import {attribute, get} from '../favicons/favicon';

/**
 * What a link's card shows of its page, for the card that opens over a link in a chat: the page's
 * own words for its title and description (Open Graph tags first, the plain ones after), the name
 * of its site and the picture it chose. The page is a stranger's: it is fetched as the favicons are,
 * every address checked before it is asked, and only its first megabyte read. What is found, or that
 * nothing was, is kept for every person alike.
 */

const PAGE_MAX_BYTES = 1_000_000;
const KEEP_MS = 60 * 60 * 1000;
const KEEP_MISS_MS = 5 * 60 * 1000;
const MAX_KEPT = 500;
const MAX_TITLE = 200;
const MAX_DESCRIPTION = 400;

export type LinkPreview = {
	url: string;
	title: string | null;
	description: string | null;
	siteName: string;
	/** The address of the picture the page chose, as an absolute https address. */
	image: string | null;
};

const ENTITIES: Record<string, string> = {amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' '};

function decode(text: string): string {
	return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, name: string) => {
		if (name.startsWith('#')) {
			const code = name[1]?.toLowerCase() === 'x' ? Number.parseInt(name.slice(2), 16) : Number.parseInt(name.slice(1), 10);
			return Number.isInteger(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
		}
		return ENTITIES[name.toLowerCase()] ?? whole;
	});
}

function clean(text: string | null | undefined, max: number): string | null {
	const words = decode(text ?? '').replace(/\s+/g, ' ').trim();
	if (words === '') {
		return null;
	}
	return words.length > max ? `${words.slice(0, max - 1).trimEnd()}…` : words;
}

function metaOf(html: string): Map<string, string> {
	const meta = new Map<string, string>();
	for (const [tag] of html.matchAll(/<meta\b[^>]*>/gi)) {
		const key = (attribute(tag, 'property') ?? attribute(tag, 'name'))?.toLowerCase();
		const content = attribute(tag, 'content');
		if (key && content && !meta.has(key)) {
			meta.set(key, content);
		}
	}
	return meta;
}

function pictureOf(src: string | undefined, page: URL): string | null {
	if (!src || !URL.canParse(src.trim(), page)) {
		return null;
	}
	const url = new URL(decode(src).trim(), page);
	return url.protocol === 'https:' ? url.toString() : null;
}

/** A page's card, from its HTML and the address it was read at. */
export function parsePreview(html: string, page: URL): LinkPreview {
	const head = html.slice(0, PAGE_MAX_BYTES);
	const meta = metaOf(head);
	const titleTag = /<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(head)?.[1];
	return {
		url: page.toString(),
		title: clean(meta.get('og:title') ?? meta.get('twitter:title') ?? titleTag, MAX_TITLE),
		description: clean(meta.get('og:description') ?? meta.get('twitter:description') ?? meta.get('description'), MAX_DESCRIPTION),
		siteName: clean(meta.get('og:site_name'), MAX_TITLE) ?? page.hostname.replace(/^www\./, ''),
		image: pictureOf(meta.get('og:image') ?? meta.get('og:image:url') ?? meta.get('twitter:image'), page),
	};
}

function bare(url: URL): LinkPreview {
	return {url: url.toString(), title: null, description: null, siteName: url.hostname.replace(/^www\./, ''), image: null};
}

async function findPreview(url: URL): Promise<LinkPreview | null> {
	const page = await get(url, 'text/html', PAGE_MAX_BYTES);
	if (page.isErr()) {
		return null;
	}
	if (!/html/i.test(page.value.type)) {
		return bare(page.value.url);
	}
	return parsePreview(new TextDecoder().decode(page.value.bytes), page.value.url);
}

const kept = new Map<string, {at: number; preview: LinkPreview | null}>();

/** The card of an https address, read once an hour at most; null where the page can't be reached. */
export async function previewOf(url: URL): Promise<LinkPreview | null> {
	const key = url.toString();
	const known = kept.get(key);
	if (known && Date.now() - known.at < (known.preview ? KEEP_MS : KEEP_MISS_MS)) {
		return known.preview;
	}
	const preview = await findPreview(url);
	kept.delete(key);
	kept.set(key, {at: Date.now(), preview});
	const [oldest] = kept.keys();
	if (kept.size > MAX_KEPT && oldest !== undefined) {
		kept.delete(oldest);
	}
	return preview;
}

/** An address the cards are made for: https, with no sign-in in it. Null for any other. */
export function previewable(address: string | undefined): URL | null {
	if (!address || address.length > 2048 || !URL.canParse(address)) {
		return null;
	}
	const url = new URL(address);
	if (url.protocol !== 'https:' || url.username !== '' || url.password !== '') {
		return null;
	}
	return url;
}

