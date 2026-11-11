export const SEARCH_HIGHLIGHT = 'chat-search-match';
export const CURRENT_SEARCH_HIGHLIGHT = 'chat-search-current';
export const MAX_CONVERSATION_SEARCH_MATCHES = 1000;

const MATCH_SCROLL_GAP_PX = 8;
const BLOCK_ELEMENTS = new Set([
	'ADDRESS',
	'BLOCKQUOTE',
	'DETAILS',
	'DIV',
	'DL',
	'FIGCAPTION',
	'FIGURE',
	'FOOTER',
	'H1',
	'H2',
	'H3',
	'H4',
	'H5',
	'H6',
	'HEADER',
	'HR',
	'LI',
	'MAIN',
	'NAV',
	'OL',
	'P',
	'PRE',
	'SECTION',
	'SUMMARY',
	'TABLE',
	'TBODY',
	'TD',
	'TFOOT',
	'TH',
	'THEAD',
	'TR',
	'UL',
]);

function escapeRegExp(value: string): string {
	return value.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&');
}

type TextPart = Text | HTMLBRElement;
type TextSegment = {parts: TextPart[]; collapseWhitespace: boolean};
type DomPoint = {node: Node; offset: number};
type SearchableSegment = {
	text: string;
	starts: DomPoint[];
	ends: DomPoint[];
	collapseWhitespace: boolean;
};
export type ConversationSearchIndex = {segments: SearchableSegment[]};
export type SearchRangesResult = {ranges: Range[]; truncated: boolean};

function textSegments(root: HTMLElement): TextSegment[] {
	const segments: TextSegment[] = [];
	let current: TextSegment | null = null;
	const flush = () => {
		if (current) {
			segments.push(current);
			current = null;
		}
	};
	const append = (part: TextPart, block: Element) => {
		const collapseWhitespace = !block.closest('pre, [data-search-whitespace="preserve"]');
		if (current?.collapseWhitespace === collapseWhitespace) {
			current.parts.push(part);
			return;
		}
		flush();
		current = {parts: [part], collapseWhitespace};
	};
	const visit = (node: Node, block: Element) => {
		if (node.nodeType === window.Node.TEXT_NODE) {
			const text = node as Text;
			const visibility = text.parentElement ? getComputedStyle(text.parentElement).visibility : '';
			if (text.data !== '' && visibility !== 'hidden' && visibility !== 'collapse') {
				append(text, block);
			}
			return;
		}
		if (!(node instanceof Element)) {
			return;
		}
		const style = getComputedStyle(node);
		const inlineStyle = node instanceof HTMLElement ? node.style : null;
		if (
			node.hasAttribute('hidden') ||
			node.classList.contains('sr-only') ||
			['NOSCRIPT', 'SCRIPT', 'STYLE', 'TEMPLATE'].includes(node.tagName) ||
			inlineStyle?.display === 'none' ||
			inlineStyle?.visibility === 'hidden' ||
			inlineStyle?.contentVisibility === 'hidden' ||
			style.display === 'none' ||
			style.contentVisibility === 'hidden'
		) {
			return;
		}
		if (node.tagName === 'BR') {
			append(node as HTMLBRElement, block);
			return;
		}
		const isBlock = BLOCK_ELEMENTS.has(node.tagName);
		if (isBlock) {
			flush();
		}
		if (node.tagName === 'DETAILS' && !node.hasAttribute('open')) {
			const summary = [...node.children].find((child) => child.tagName === 'SUMMARY');
			if (summary) {
				visit(summary, node);
			}
			flush();
			return;
		}
		const childBlock = isBlock ? node : block;
		for (const child of node.childNodes) {
			visit(child, childBlock);
		}
		if (isBlock) {
			flush();
		}
	};
	visit(root, root);
	flush();
	return segments;
}

function searchableText(segment: TextSegment): SearchableSegment {
	let text = '';
	const starts: DomPoint[] = [];
	const ends: DomPoint[] = [];
	let previousWasWhitespace = false;
	const append = (character: string, start: DomPoint, end: DomPoint) => {
		const whitespace = segment.collapseWhitespace && /[\t\n\f\r ]/.test(character);
		if (whitespace && previousWasWhitespace) {
			ends[ends.length - 1] = end;
			return;
		}
		text += whitespace ? ' ' : character;
		starts.push(start);
		ends.push(end);
		previousWasWhitespace = whitespace;
	};
	for (const node of segment.parts) {
		if (node.nodeName === 'BR') {
			const parent = node.parentNode;
			if (!parent) {
				continue;
			}
			const offset = [...parent.childNodes].indexOf(node);
			append(
				segment.collapseWhitespace ? ' ' : '\n',
				{node: parent, offset},
				{
					node: parent,
					offset: offset + 1,
				},
			);
			continue;
		}
		const textNode = node as Text;
		for (let offset = 0; offset < textNode.data.length; offset += 1) {
			const character = textNode.data[offset] ?? '';
			append(character, {node: textNode, offset}, {node: textNode, offset: offset + 1});
		}
	}
	return {text, starts, ends, collapseWhitespace: segment.collapseWhitespace};
}

function rangesInSegment(
	searchable: SearchableSegment,
	query: RegExp,
	limit: number,
): SearchRangesResult {
	const ranges: Range[] = [];
	for (const occurrence of searchable.text.matchAll(query)) {
		if (ranges.length === limit) {
			return {ranges, truncated: true};
		}
		const start = occurrence.index;
		const end = start + occurrence[0].length;
		const startPoint = searchable.starts[start];
		const endPoint = searchable.ends[end - 1];
		if (!startPoint || !endPoint) {
			continue;
		}
		const range = document.createRange();
		range.setStart(startPoint.node, startPoint.offset);
		range.setEnd(endPoint.node, endPoint.offset);
		ranges.push(range);
	}
	return {ranges, truncated: false};
}

export function createConversationSearchIndex(root: HTMLElement): ConversationSearchIndex {
	return {segments: textSegments(root).map(searchableText)};
}

// Search visible text as the browser renders it. Inline formatting stays searchable as one phrase,
// while separate paragraphs, list items and table cells cannot create false cross-block matches.
export function searchConversationIndex(
	index: ConversationSearchIndex,
	query: string,
	limit = MAX_CONVERSATION_SEARCH_MATCHES,
): SearchRangesResult {
	if (query === '') {
		return {ranges: [], truncated: false};
	}
	const collapsedQuery = query.replace(/[\t\n\f\r ]+/g, ' ');
	const collapsedExpression = new RegExp(escapeRegExp(collapsedQuery), 'giu');
	const preservedExpression = new RegExp(escapeRegExp(query), 'giu');
	const ranges: Range[] = [];
	for (const segment of index.segments) {
		const expression = segment.collapseWhitespace ? collapsedExpression : preservedExpression;
		const found = rangesInSegment(segment, expression, limit - ranges.length);
		ranges.push(...found.ranges);
		if (found.truncated) {
			return {ranges, truncated: true};
		}
	}
	return {ranges, truncated: false};
}

export function searchRanges(
	root: HTMLElement,
	query: string,
	limit = MAX_CONVERSATION_SEARCH_MATCHES,
): SearchRangesResult {
	return searchConversationIndex(createConversationSearchIndex(root), query, limit);
}

export function scrollRangeIntoView(
	range: Range,
	viewport: HTMLElement | null,
	overlay: HTMLElement | null,
	fallback: HTMLElement | undefined,
): () => void {
	let frame: number | null = null;
	const scroll = (mayRevealSkippedContent: boolean) => {
		if (!viewport) {
			fallback?.scrollIntoView?.({block: 'center'});
			return;
		}
		const match = range.getBoundingClientRect();
		if (match.width === 0 && match.height === 0) {
			fallback?.scrollIntoView?.({block: 'center'});
			if (!fallback || !mayRevealSkippedContent) {
				return;
			}
			frame = requestAnimationFrame(() => {
				frame = null;
				scroll(false);
			});
			return;
		}
		const visible = viewport.getBoundingClientRect();
		const floating = overlay?.getBoundingClientRect();
		const overlayCoversMatch =
			floating &&
			floating.left < match.right &&
			floating.right > match.left &&
			floating.bottom > match.top;
		const top = overlayCoversMatch ? floating.bottom + MATCH_SCROLL_GAP_PX : visible.top;
		if (match.top < top) {
			viewport.scrollBy({top: match.top - top});
		}
		if (match.top >= top && match.bottom > visible.bottom) {
			viewport.scrollBy({top: match.bottom - visible.bottom});
		}

		let element =
			range.commonAncestorContainer.nodeType === window.Node.ELEMENT_NODE
				? (range.commonAncestorContainer as Element)
				: range.commonAncestorContainer.parentElement;
		while (element) {
			if (element instanceof HTMLElement && element.scrollWidth > element.clientWidth) {
				const horizontal = element.getBoundingClientRect();
				if (match.left < horizontal.left) {
					element.scrollBy({left: match.left - horizontal.left});
					return;
				}
				if (match.right > horizontal.right) {
					element.scrollBy({left: match.right - horizontal.right});
				}
				return;
			}
			if (element === fallback) {
				return;
			}
			element = element.parentElement;
		}
	};
	scroll(true);
	return () => {
		if (frame !== null) {
			cancelAnimationFrame(frame);
		}
	};
}
