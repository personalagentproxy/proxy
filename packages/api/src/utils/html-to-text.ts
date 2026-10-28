const ENTITIES: Record<string, string> = {amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' '};

// A character by its number, or the replacement character for one Unicode doesn't have.
function codePoint(digits: string, radix: number): string {
	const value = Number.parseInt(digits, radix);
	if (!Number.isInteger(value) || value < 1 || value > 0x10ffff) {
		return '\uFFFD';
	}
	return String.fromCodePoint(value);
}

function decodeEntities(text: string): string {
	return text.replace(/&(#x[0-9a-f]{1,8}|#\d{1,8}|[a-z]{1,32});/gi, (entity, name: string) => {
		if (name.startsWith('#x') || name.startsWith('#X')) {
			return codePoint(name.slice(2), 16);
		}
		if (name.startsWith('#')) {
			return codePoint(name.slice(1), 10);
		}
		return ENTITIES[name.toLowerCase()] ?? entity;
	});
}

// Elements whose content is never text.
const HIDDEN = ['script', 'style', 'head', 'title'];

// Elements ending a line where they close.
const BLOCKS = ['p', 'div', 'tr', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'blockquote', 'table', 'ul', 'ol'];

// What a tag becomes in the text, by its name and whether it closes an element.
function tagText(name: string, closing: boolean): string {
	if (name === 'br') {
		return '\n';
	}
	if (name === 'li' && !closing) {
		return '\n- ';
	}
	if (closing && BLOCKS.includes(name)) {
		return '\n';
	}
	return '';
}

/**
 * HTML as plain text, as an email without a text part is read: blocks and line breaks as new lines, a
 * link's address after its text where they differ, everything else's tags dropped. Read in one
 * pass, each tag found from where the last ended, so the time it takes grows with the email's
 * length whatever its HTML looks like, unclosed tags and all.
 */
export function htmlToText(html: string): string {
	const parts: string[] = [];
	// The link being read: its address, and where its text starts among the parts.
	let link: {href: string; start: number} | null = null;
	let at = 0;
	while (at < html.length) {
		const open = html.indexOf('<', at);
		if (open === -1) {
			parts.push(sourceText(html.slice(at)));
			break;
		}
		parts.push(sourceText(html.slice(at, open)));
		// A < that starts no tag, as in "1 < 2", is text.
		if (!/[a-z/!?]/i.test(html.charAt(open + 1))) {
			parts.push('<');
			at = open + 1;
			continue;
		}
		if (html.startsWith('<!--', open)) {
			const end = html.indexOf('-->', open + 4);
			at = end === -1 ? html.length : end + 3;
			continue;
		}
		const close = html.indexOf('>', open);
		if (close === -1) {
			parts.push(sourceText(html.slice(open)));
			break;
		}
		const tag = html.slice(open, close + 1);
		at = close + 1;
		const [, slash = '', rawName = ''] = /^<(\/?)([a-z][a-z0-9]*)/i.exec(tag) ?? [];
		const name = rawName.toLowerCase();
		const closing = slash === '/';
		if (!closing && HIDDEN.includes(name)) {
			const end = indexOfTag(html, `</${name}`, at);
			const endClose = end === -1 ? -1 : html.indexOf('>', end);
			at = endClose === -1 ? html.length : endClose + 1;
			continue;
		}
		if (name === 'a' && !closing) {
			const href = /\shref\s*=\s*"([^"]*)"/i.exec(tag)?.[1];
			link = href === undefined ? null : {href, start: parts.length};
			continue;
		}
		if (name === 'a' && closing && link) {
			const label = parts.splice(link.start).join('').trim();
			parts.push(label === '' || label === link.href ? link.href : `${label} (${link.href})`);
			link = null;
			continue;
		}
		parts.push(tagText(name, closing));
	}
	return decodeEntities(parts.join(''))
		.replace(/[ \t\u00a0]+/g, ' ')
		.replace(/ ?\n ?/g, '\n')
		.replace(/\n{3,}/g, '\n\n')
		.trim();
}

// Text between tags: a line break in the HTML's source is a space, as a browser shows it.
function sourceText(text: string): string {
	return text.replace(/\r\n?|\n/g, ' ');
}

// Where a tag next starts from `from`, whatever its case. The email isn't lowercased whole to look,
// since a letter can lowercase to more than one, as İ does, which would move everything after it.
function indexOfTag(html: string, tag: string, from: number): number {
	const pattern = new RegExp(tag, 'ig');
	pattern.lastIndex = from;
	return pattern.exec(html)?.index ?? -1;
}
