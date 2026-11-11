/// <reference types="bun" />

import type {ChatEntry} from '@proxy/contracts/harness';
import {afterEach, beforeEach, describe, expect, test} from 'bun:test';
import {cleanup, fireEvent, render, screen, waitFor} from '@testing-library/react';
import {useConversationSearch} from '@/hooks/use-conversation-search';

const originalCss = Object.getOwnPropertyDescriptor(globalThis, 'CSS');
const originalHighlight = Object.getOwnPropertyDescriptor(globalThis, 'Highlight');

class TestHighlight extends Set<Range> {
	constructor(...ranges: Range[]) {
		super(ranges);
	}
}

function restoreGlobal(name: 'CSS' | 'Highlight', descriptor: PropertyDescriptor | undefined) {
	if (descriptor) {
		Object.defineProperty(globalThis, name, descriptor);
		return;
	}
	Reflect.deleteProperty(globalThis, name);
}

beforeEach(() => {
	Object.defineProperty(globalThis, 'CSS', {
		configurable: true,
		value: {highlights: new Map<string, TestHighlight>()},
	});
	Object.defineProperty(globalThis, 'Highlight', {
		configurable: true,
		value: TestHighlight,
	});
});

afterEach(() => {
	cleanup();
	restoreGlobal('CSS', originalCss);
	restoreGlobal('Highlight', originalHighlight);
});

function entry(id: string, text: string): ChatEntry {
	return {
		id,
		kind: 'assistant',
		text,
		isError: false,
		at: '2026-11-10T12:00:00Z',
	};
}

function SearchHarness({
	entries,
	onScroll,
}: {
	entries: ChatEntry[];
	onScroll?: (entryId: string) => void;
}) {
	const {activeMatch, changeQuery, inputRef, matchCount, next, query, rememberEntryElement} =
		useConversationSearch(entries, false);
	return (
		<>
			<input
				ref={inputRef}
				aria-label="Search"
				value={query}
				onChange={(event) => changeQuery(event.target.value)}
			/>
			<output aria-label="Search state">
				{matchCount}:{activeMatch}
			</output>
			<button type="button" onClick={next}>
				Next
			</button>
			{entries.map((item) => (
				<div
					key={item.id}
					data-testid={`entry-${item.id}`}
					ref={(element) => {
						rememberEntryElement(item.id, element);
						if (element && onScroll) {
							element.scrollIntoView = () => onScroll(item.id);
						}
					}}
				>
					{item.text}
				</div>
			))}
		</>
	);
}

describe('useConversationSearch', () => {
	test('rebuilds matches and bounds the active result when polled entries change', () => {
		const {rerender} = render(
			<SearchHarness entries={[entry('one', 'pricing one'), entry('two', 'pricing two')]} />,
		);
		fireEvent.keyDown(window, {key: 'f', metaKey: true});
		fireEvent.change(screen.getByLabelText('Search'), {target: {value: 'pricing'}});
		expect(screen.getByLabelText('Search state').textContent).toBe('2:0');
		fireEvent.click(screen.getByRole('button', {name: 'Next'}));
		expect(screen.getByLabelText('Search state').textContent).toBe('2:1');

		rerender(<SearchHarness entries={[entry('three', 'new pricing')]} />);

		expect(screen.getByLabelText('Search state').textContent).toBe('1:0');
		rerender(
			<SearchHarness entries={[entry('three', 'new pricing'), entry('four', 'more pricing')]} />,
		);
		expect(screen.getByLabelText('Search state').textContent).toBe('2:0');
		fireEvent.change(screen.getByLabelText('Search'), {target: {value: ''}});
		rerender(<SearchHarness entries={[entry('three', 'replacement answer')]} />);
		fireEvent.change(screen.getByLabelText('Search'), {target: {value: 'replacement'}});
		expect(screen.getByLabelText('Search state').textContent).toBe('1:0');
	});

	test('waits for the new query matches before scrolling', () => {
		const scrolled: string[] = [];
		render(
			<SearchHarness
				entries={[entry('one', 'old answer'), entry('two', 'old and new answer')]}
				onScroll={(entryId) => scrolled.push(entryId)}
			/>,
		);
		fireEvent.keyDown(window, {key: 'f', metaKey: true});
		fireEvent.change(screen.getByLabelText('Search'), {target: {value: 'old'}});
		fireEvent.click(screen.getByRole('button', {name: 'Next'}));
		scrolled.length = 0;

		fireEvent.change(screen.getByLabelText('Search'), {target: {value: 'new'}});

		expect(scrolled).toEqual(['two']);
	});

	test('rebuilds a cached index after the rendered message mutates', async () => {
		render(<SearchHarness entries={[entry('one', 'old answer')]} />);
		fireEvent.keyDown(window, {key: 'f', metaKey: true});
		fireEvent.change(screen.getByLabelText('Search'), {target: {value: 'new'}});
		expect(screen.getByLabelText('Search state').textContent).toBe('0:0');

		screen.getByTestId('entry-one').textContent = 'new answer';

		await waitFor(() => {
			expect(screen.getByLabelText('Search state').textContent).toBe('1:0');
		});
	});
});
