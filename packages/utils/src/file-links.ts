/**
 * A file's address in the web app, as an agent hands it to the person: its drive's page, with the
 * file shown, `<origin>/<org>/connections/<connection>?folder=<folder>&file=<file>` (api
 * native/files/links.ts makes it). Read back here where an answer shows a file as a picture,
 * `![what it shows](address)`: by the api, which keeps the file at the version it holds as the
 * answer is written, and by the Chat page, which shows the file it kept in the picture's place.
 */

/** A file a link points to: the organization, the drive and the file, by their slug and ids. */
export type FileLinkTarget = {org: string; connectionId: string; fileId: string};

/** The file `href` points to, where it is an address of the web app at `origin`; null for any other. */
export function readFileLink(href: string, origin: string): FileLinkTarget | null {
	if (!URL.canParse(href, origin)) {
		return null;
	}
	const url = new URL(href, origin);
	if (url.origin !== new URL(origin).origin) {
		return null;
	}
	const [org, connections, connectionId, ...rest] = url.pathname
		.split('/')
		.filter((part) => part !== '');
	const fileId = url.searchParams.get('file');
	if (
		org === undefined ||
		connections !== 'connections' ||
		connectionId === undefined ||
		rest.length > 0 ||
		!fileId
	) {
		return null;
	}
	return {org: decodeURIComponent(org), connectionId: decodeURIComponent(connectionId), fileId};
}

// A Markdown image: `![alt](address)`, the address maybe in angle brackets, maybe with a title.
const IMAGE = /!\[[^\]]*\]\(\s*<?([^\s<>()]+)>?(?:\s+(?:"[^"]*"|'[^']*'))?\s*\)/g;

/** The addresses of the pictures a Markdown text shows, in the order shown. */
export function markdownImages(text: string): string[] {
	return [...text.matchAll(IMAGE)].flatMap((match) => (match[1] === undefined ? [] : [match[1]]));
}
