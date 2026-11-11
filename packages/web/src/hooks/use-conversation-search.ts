import type {ChatEntry} from '@proxy/contracts/harness';
import {useCallback, useEffect, useLayoutEffect, useRef, useState} from 'react';
import {
	CURRENT_SEARCH_HIGHLIGHT,
	MAX_CONVERSATION_SEARCH_MATCHES,
	SEARCH_HIGHLIGHT,
	createConversationSearchIndex,
	scrollRangeIntoView,
	searchConversationIndex,
} from '@/lib/conversation-search';
import type {ConversationSearchIndex} from '@/lib/conversation-search';

type SearchMatch = {entryId: string; range: Range};
type CachedSearchIndex = {
	element: HTMLDivElement;
	markup: string;
	index: ConversationSearchIndex;
};

function supportsConversationSearch(): boolean {
	return typeof CSS !== 'undefined' && 'highlights' in CSS && typeof Highlight !== 'undefined';
}

export function useConversationSearch(entries: ChatEntry[], disabled: boolean) {
	const inputRef = useRef<HTMLInputElement>(null);
	const overlayRef = useRef<HTMLDivElement>(null);
	const viewportRef = useRef<HTMLDivElement>(null);
	const entryElements = useRef(new Map<string, HTMLDivElement>());
	const searchIndexes = useRef(new Map<string, CachedSearchIndex>());
	const searchObservers = useRef(new Map<string, MutationObserver>());
	const indexedEntries = useRef(entries);
	const focusedBeforeSearch = useRef<HTMLElement | null>(null);
	const shouldScroll = useRef(false);
	const [open, setOpen] = useState(false);
	const [query, setQuery] = useState('');
	const [matches, setMatches] = useState<SearchMatch[]>([]);
	const [matchedQuery, setMatchedQuery] = useState('');
	const [matchesTruncated, setMatchesTruncated] = useState(false);
	const [activeMatch, setActiveMatch] = useState(0);
	const [domRevision, setDomRevision] = useState(0);

	const rememberEntryElement = useCallback((entryId: string, element: HTMLDivElement | null) => {
		searchObservers.current.get(entryId)?.disconnect();
		searchObservers.current.delete(entryId);
		if (element) {
			entryElements.current.set(entryId, element);
			searchIndexes.current.delete(entryId);
			const observer = new MutationObserver(() => {
				searchIndexes.current.delete(entryId);
				setDomRevision((current) => current + 1);
			});
			observer.observe(element, {
				attributes: true,
				characterData: true,
				childList: true,
				subtree: true,
			});
			searchObservers.current.set(entryId, observer);
			return;
		}
		entryElements.current.delete(entryId);
		searchIndexes.current.delete(entryId);
	}, []);

	useEffect(() => {
		const find = (event: globalThis.KeyboardEvent) => {
			if (disabled || event.altKey || (!event.metaKey && !event.ctrlKey)) {
				return;
			}
			if (event.key.toLocaleLowerCase() !== 'f') {
				return;
			}
			if (!supportsConversationSearch()) {
				return;
			}
			event.preventDefault();
			if (open) {
				inputRef.current?.focus();
				inputRef.current?.select();
				return;
			}
			focusedBeforeSearch.current =
				document.activeElement instanceof HTMLElement ? document.activeElement : null;
			shouldScroll.current = true;
			setOpen(true);
		};
		window.addEventListener('keydown', find);
		return () => window.removeEventListener('keydown', find);
	}, [disabled, open]);

	useEffect(() => {
		if (!open) {
			return;
		}
		inputRef.current?.focus();
		inputRef.current?.select();
	}, [open]);

	const close = useCallback(() => {
		setOpen(false);
		const previous = focusedBeforeSearch.current;
		if (previous?.isConnected) {
			previous.focus();
		}
	}, []);

	const changeQuery = useCallback((value: string) => {
		shouldScroll.current = true;
		setQuery(value);
		setActiveMatch(0);
	}, []);

	const previous = useCallback(() => {
		if (matches.length === 0) {
			return;
		}
		shouldScroll.current = true;
		setActiveMatch(
			(current) => (Math.min(current, matches.length - 1) - 1 + matches.length) % matches.length,
		);
	}, [matches.length]);

	const next = useCallback(() => {
		if (matches.length === 0) {
			return;
		}
		shouldScroll.current = true;
		setActiveMatch((current) => (Math.min(current, matches.length - 1) + 1) % matches.length);
	}, [matches.length]);

	/* oxlint-disable react/set-state-in-effect -- Matches are necessarily read from rendered DOM. */
	useLayoutEffect(() => {
		const entriesChanged = indexedEntries.current !== entries;
		indexedEntries.current = entries;
		if (entriesChanged) {
			for (const entry of entries) {
				const cached = searchIndexes.current.get(entry.id);
				const element = entryElements.current.get(entry.id);
				if (
					cached &&
					(!element || cached.element !== element || cached.markup !== element.innerHTML)
				) {
					searchIndexes.current.delete(entry.id);
				}
			}
		}
		if (!open || query === '') {
			setMatches([]);
			setMatchedQuery(query);
			setMatchesTruncated(false);
			setActiveMatch(0);
			return;
		}
		const found: SearchMatch[] = [];
		let truncated = false;
		for (const entry of entries) {
			const element = entryElements.current.get(entry.id);
			if (!element) {
				continue;
			}
			let cached = searchIndexes.current.get(entry.id);
			if (!cached || cached.element !== element) {
				const markup = element.innerHTML;
				cached = {element, markup, index: createConversationSearchIndex(element)};
				searchIndexes.current.set(entry.id, cached);
			}
			const result = searchConversationIndex(
				cached.index,
				query,
				MAX_CONVERSATION_SEARCH_MATCHES - found.length,
			);
			found.push(...result.ranges.map((range) => ({entryId: entry.id, range})));
			if (result.truncated) {
				truncated = true;
				break;
			}
		}
		setMatches(found);
		setMatchedQuery(query);
		setMatchesTruncated(truncated);
		setActiveMatch((current) => (found.length === 0 ? 0 : Math.min(current, found.length - 1)));
	}, [open, query, entries, domRevision]);
	/* oxlint-enable react/set-state-in-effect */

	const shownActiveMatch = matches.length === 0 ? 0 : Math.min(activeMatch, matches.length - 1);

	useEffect(() => {
		if (!open || !shouldScroll.current || matchedQuery !== query) {
			return;
		}
		const active = matches[shownActiveMatch];
		if (!active) {
			return;
		}
		shouldScroll.current = false;
		return scrollRangeIntoView(
			active.range,
			viewportRef.current,
			overlayRef.current,
			entryElements.current.get(active.entryId),
		);
	}, [open, query, matchedQuery, matches, shownActiveMatch]);

	useEffect(() => {
		if (!supportsConversationSearch()) {
			return;
		}
		CSS.highlights.delete(SEARCH_HIGHLIGHT);
		if (!open || matches.length === 0) {
			return;
		}
		const all = new Highlight();
		for (const match of matches) {
			all.add(match.range);
		}
		CSS.highlights.set(SEARCH_HIGHLIGHT, all);
		return () => {
			CSS.highlights.delete(SEARCH_HIGHLIGHT);
		};
	}, [open, matches]);

	useEffect(() => {
		if (!supportsConversationSearch()) {
			return;
		}
		CSS.highlights.delete(CURRENT_SEARCH_HIGHLIGHT);
		const active = matches[shownActiveMatch];
		if (!open || !active) {
			return;
		}
		CSS.highlights.set(CURRENT_SEARCH_HIGHLIGHT, new Highlight(active.range));
		return () => {
			CSS.highlights.delete(CURRENT_SEARCH_HIGHLIGHT);
		};
	}, [open, matches, shownActiveMatch]);

	return {
		activeMatch: shownActiveMatch,
		changeQuery,
		close,
		inputRef,
		matchCount: matches.length,
		matchesTruncated,
		next,
		open,
		overlayRef,
		previous,
		query,
		rememberEntryElement,
		viewportRef,
	};
}
