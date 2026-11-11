import {Button} from '@proxy/ui/components/button';
import {Input} from '@proxy/ui/components/input';
import {ChevronDownIcon, ChevronUpIcon, SearchIcon, XIcon} from 'lucide-react';
import type {KeyboardEvent, RefObject} from 'react';
import {CURRENT_SEARCH_HIGHLIGHT, SEARCH_HIGHLIGHT} from '@/lib/conversation-search';

// The CSS optimizer does not recognize Custom Highlight pseudo-elements yet. Keeping these two
// rules with the only UI that registers them avoids build warnings and a separate uncompiled asset.
const HIGHLIGHT_STYLES = `
::highlight(${SEARCH_HIGHLIGHT}) {
	background-color: oklch(0.9 0.14 95);
	color: oklch(0.2 0.02 85);
}
::highlight(${CURRENT_SEARCH_HIGHLIGHT}) {
	background-color: oklch(0.78 0.17 75);
	color: oklch(0.2 0.02 75);
}`;

type Props = {
	inputRef: RefObject<HTMLInputElement | null>;
	rootRef: RefObject<HTMLDivElement | null>;
	controlsId: string;
	query: string;
	matchCount: number;
	matchesTruncated: boolean;
	activeMatch: number;
	onQueryChange: (query: string) => void;
	onPrevious: () => void;
	onNext: () => void;
	onClose: () => void;
};

// The find bar for the open conversation. Enter walks forward through matches, Shift+Enter walks
// backward, like the browser's own find bar; Escape returns to what had focus before it opened.
export function ConversationSearch({
	inputRef,
	rootRef,
	controlsId,
	query,
	matchCount,
	matchesTruncated,
	activeMatch,
	onQueryChange,
	onPrevious,
	onNext,
	onClose,
}: Props) {
	const onSearchKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
		if (event.nativeEvent.isComposing) {
			return;
		}
		if (event.key === 'Escape') {
			event.preventDefault();
			onClose();
		}
	};

	const onInputKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
		if (event.nativeEvent.isComposing) {
			return;
		}
		if (event.key !== 'Enter') {
			return;
		}
		event.preventDefault();
		if (event.shiftKey) {
			onPrevious();
			return;
		}
		onNext();
	};

	const result = () => {
		if (query === '') {
			return '';
		}
		if (matchCount === 0) {
			return 'No matches';
		}
		return `${activeMatch + 1} of ${matchCount}${matchesTruncated ? '+' : ''}`;
	};

	return (
		<>
			<style>{HIGHLIGHT_STYLES}</style>
			<div
				ref={rootRef}
				role="search"
				aria-label="Search conversation"
				onKeyDown={onSearchKeyDown}
				className="flex h-10 w-full items-center gap-1 rounded-lg border bg-background px-2 shadow-lg focus-within:border-ring focus-within:ring-3 focus-within:ring-ring/50"
			>
				<SearchIcon className="size-4 shrink-0 text-muted-foreground" aria-hidden />
				<Input
					ref={inputRef}
					type="text"
					value={query}
					onChange={(event) => onQueryChange(event.target.value)}
					onKeyDown={onInputKeyDown}
					aria-label="Find in conversation"
					aria-controls={controlsId}
					placeholder="Find in chat"
					className="h-8 border-0 bg-transparent px-1 shadow-none focus-visible:ring-0 dark:bg-transparent"
				/>
				<span
					role="status"
					aria-live="polite"
					className="min-w-16 shrink-0 text-right text-xs whitespace-nowrap text-muted-foreground"
				>
					{result()}
				</span>
				<Button
					type="button"
					variant="ghost"
					size="icon-xs"
					aria-label="Previous match"
					disabled={matchCount === 0}
					onClick={onPrevious}
				>
					<ChevronUpIcon />
				</Button>
				<Button
					type="button"
					variant="ghost"
					size="icon-xs"
					aria-label="Next match"
					disabled={matchCount === 0}
					onClick={onNext}
				>
					<ChevronDownIcon />
				</Button>
				<Button
					type="button"
					variant="ghost"
					size="icon-xs"
					aria-label="Close search"
					onClick={onClose}
				>
					<XIcon />
				</Button>
			</div>
		</>
	);
}
