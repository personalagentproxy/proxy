import {ATTACHMENT_MARK} from '@proxy/utils/harness';

import {toSlackText} from './message-rules';

/**
 * What a thread says, as it goes into a Slack message, with no Slack and no database in it. The
 * agent writes short Markdown, and `chat.postMessage` takes standard Markdown in `markdown_text`, at
 * most 12,000 characters (https://docs.slack.dev/reference/methods/chat.postMessage); what Slack
 * can't show is turned into what it can: a picture into a link with its words, since files don't go
 * to Slack; an address in the app, which the page links from where it is, into a full one under
 * APP_URL; the marks where a member's files sat taken out. Code, in a block or inline, is left as
 * written. A message longer than Slack takes is cut at its paragraphs' ends into several.
 */

/** The most `markdown_text` takes. */
export const SLACK_MARKDOWN_LIMIT = 12_000;

// An address in the app, as the page links one: a path from its root, not `//host`.
function inApp(href: string): boolean {
	return href.startsWith('/') && !href.startsWith('//');
}

// The address as Slack can open it: one in the app under APP_URL.
function fullAddress(href: string, appUrl: string): string {
	return inApp(href) ? `${appUrl.replace(/\/$/, '')}${href}` : href;
}

// A link's words, their brackets kept as words.
function linkWords(words: string): string {
	return words.replaceAll('[', '\\[').replaceAll(']', '\\]');
}

// A file's mark, with the spaces around it: at a line's start or end, or before a stop, where it
// leaves nothing; anywhere else, where it leaves a space between the words around it.
const MARK_AT_EDGE = new RegExp(`(^|\\n)[ \\t]*${ATTACHMENT_MARK}[ \\t]*|[ \\t]*${ATTACHMENT_MARK}[ \\t]*(?=[.,;:!?)]|\\n|$)`, 'g');
const MARK = new RegExp(`[ \\t]*${ATTACHMENT_MARK}[ \\t]*`, 'g');

// Prose, with no code in it, as Slack is to show it.
function convertProse(text: string, appUrl: string): string {
	return text
		.replace(MARK_AT_EDGE, '$1')
		.replace(MARK, ' ')
		.replace(/!\[([^\]]*)\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g, (_, alt: string, src: string) => `[${linkWords(alt.trim() === '' ? 'Picture' : alt.trim())}](${fullAddress(src, appUrl)})`)
		.replace(/(?<!!)\[((?:\\.|[^\]\\])*)\]\(\s*<?([^)\s>]+)>?((?:\s+"[^"]*")?)\s*\)/g, (_, words: string, href: string, title: string) => `[${words}](${fullAddress(href, appUrl)}${title})`);
}

// The text cut into prose and code, a fenced block or an inline span, each kept as it is.
function pieces(text: string): Array<{code: boolean; text: string}> {
	const out: Array<{code: boolean; text: string}> = [];
	let at = 0;
	for (const match of text.matchAll(/```[\s\S]*?(?:```|$)|`[^`\n]+`/g)) {
		out.push({code: false, text: text.slice(at, match.index)}, {code: true, text: match[0]});
		at = match.index + match[0].length;
	}
	out.push({code: false, text: text.slice(at)});
	return out;
}

/** The Markdown as Slack is to show it: pictures as links, addresses in the app in full, files' marks out, its lines' ends and its ends trimmed. */
export function toSlackMarkdown(text: string, appUrl: string): string {
	return pieces(text)
		.map((piece) => (piece.code ? piece.text : convertProse(piece.text, appUrl)))
		.join('')
		.replace(/[ \t]+$/gm, '')
		.trim();
}

// A piece too long for a part, cut at the last of `at` before the limit; at the limit where it has none.
function cutAt(text: string, limit: number, at: string): [string, string] {
	const end = text.lastIndexOf(at, limit);
	if (end <= 0) {
		return [text.slice(0, limit), text.slice(limit)];
	}
	return [text.slice(0, end), text.slice(end + at.length)];
}

// A paragraph longer than a part, cut at its lines' ends, then at spaces, then anywhere.
function cutParagraph(paragraph: string, limit: number): string[] {
	const parts: string[] = [];
	let rest = paragraph;
	while (rest.length > limit) {
		const separator = rest.lastIndexOf('\n', limit) > 0 ? '\n' : ' ';
		const [head, tail] = cutAt(rest, limit, separator);
		parts.push(head);
		rest = tail;
	}
	return [...parts, rest];
}

// The text's paragraphs, a block of code one however many blank lines it holds.
function paragraphs(text: string): string[] {
	const out: string[] = [];
	let lines: string[] = [];
	let inCode = false;
	for (const line of text.split('\n')) {
		if (line.trimStart().startsWith('```')) {
			inCode = !inCode;
		}
		if (line.trim() === '' && !inCode) {
			out.push(lines.join('\n'));
			lines = [];
			continue;
		}
		lines.push(line);
	}
	return [...out, lines.join('\n')].filter((paragraph) => paragraph.trim() !== '');
}

/**
 * The text as Slack messages of at most `limit` characters, in order: paragraphs together while
 * they fit, cut at a paragraph's end, a block of code being one; one longer alone cut at its lines'
 * ends, then its spaces. None empty, and none at all for nothing.
 */
export function splitForSlack(text: string, limit: number = SLACK_MARKDOWN_LIMIT): string[] {
	const parts: string[] = [];
	let current = '';
	for (const paragraph of paragraphs(text).flatMap((one) => cutParagraph(one, limit))) {
		const joined = current === '' ? paragraph : `${current}\n\n${paragraph}`;
		if (joined.length <= limit) {
			current = joined;
			continue;
		}
		parts.push(current);
		current = paragraph;
	}
	return [...parts, current].map((part) => part.trim()).filter((part) => part !== '');
}

/** Markdown as a plain message in Slack's own text format, for one Slack wouldn't take as Markdown: its control characters escaped, nothing else. */
export function toPlainSlackText(markdown: string): string {
	return toSlackText(markdown);
}

/** The text with each line quoted, as Markdown, a blank one too, so a quote of several paragraphs stays one. */
export function quoted(text: string): string {
	return text
		.split('\n')
		.map((line) => (line === '' ? '>' : `> ${line}`))
		.join('\n');
}
