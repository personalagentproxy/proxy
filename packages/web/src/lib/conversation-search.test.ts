/// <reference types="bun" />

import {describe, expect, test} from 'bun:test';
import {
	createConversationSearchIndex,
	scrollRangeIntoView,
	searchConversationIndex,
	searchRanges,
} from '@/lib/conversation-search';

describe('searchRanges', () => {
	test('matches one phrase across inline formatting', () => {
		const message = document.createElement('div');
		message.innerHTML = '<p>Review the <strong>pricing</strong> plan</p>';

		const {ranges} = searchRanges(message, 'the pricing');

		expect(ranges).toHaveLength(1);
		expect(ranges[0]?.toString()).toBe('the pricing');
	});

	test('does not join text from separate rendered blocks', () => {
		const message = document.createElement('div');
		message.innerHTML = '<p>price</p><p>less</p>';

		expect(searchRanges(message, 'priceless').ranges).toHaveLength(0);
	});

	test('does not join parent text around a nested block', () => {
		const message = document.createElement('div');
		message.innerHTML = '<div>foo<p>bar</p>baz</div>';

		expect(searchRanges(message, 'foobaz').ranges).toHaveLength(0);
		expect(searchRanges(message, 'bar').ranges).toHaveLength(1);
	});

	test('does not match text that is not rendered', () => {
		const message = document.createElement('div');
		message.innerHTML = [
			'<span hidden>hidden attribute</span>',
			'<span style="display: none">hidden style</span>',
			'<span class="sr-only">screen reader label</span>',
			'<details><summary>visible summary</summary>closed detail</details>',
			'<span>visible answer</span>',
		].join('');

		expect(searchRanges(message, 'hidden').ranges).toHaveLength(0);
		expect(searchRanges(message, 'screen reader').ranges).toHaveLength(0);
		expect(searchRanges(message, 'closed detail').ranges).toHaveLength(0);
		expect(searchRanges(message, 'visible summary').ranges).toHaveLength(1);
		expect(searchRanges(message, 'visible answer').ranges).toHaveLength(1);
	});

	test('treats a rendered line break as whitespace instead of joining its words', () => {
		const message = document.createElement('div');
		message.innerHTML = '<p>price<br>review</p>';

		expect(searchRanges(message, 'pricereview').ranges).toHaveLength(0);
		expect(searchRanges(message, 'price review').ranges).toHaveLength(1);
	});

	test('matches collapsed rendered whitespace and preserves its DOM range', () => {
		const message = document.createElement('div');
		message.innerHTML = '<p>Review\n  <strong>pricing</strong></p>';

		const {ranges} = searchRanges(message, 'Review pricing');

		expect(ranges).toHaveLength(1);
		expect(ranges[0]?.toString()).toBe('Review\n  pricing');
	});

	test('does not collapse whitespace that the message visibly preserves', () => {
		const message = document.createElement('div');
		message.innerHTML = '<div data-search-whitespace="preserve">Review\npricing</div>';

		expect(searchRanges(message, 'Review pricing').ranges).toHaveLength(0);
	});

	test('matches exact repeated whitespace where the message preserves it', () => {
		const message = document.createElement('div');
		message.innerHTML = '<pre>Review  pricing</pre>';

		expect(searchRanges(message, 'Review  pricing').ranges).toHaveLength(1);
		expect(searchRanges(message, 'Review pricing').ranges).toHaveLength(0);
	});

	test('caps materialized ranges and reports that more matches exist', () => {
		const message = document.createElement('div');
		message.innerHTML = '<p>aaaa</p>';

		const result = searchRanges(message, 'a', 2);

		expect(result.ranges).toHaveLength(2);
		expect(result.truncated).toBe(true);
	});

	test('reuses a rendered-text index across queries', () => {
		const message = document.createElement('div');
		message.innerHTML = '<p>Pricing plan and approval</p>';
		const index = createConversationSearchIndex(message);

		expect(searchConversationIndex(index, 'pricing').ranges).toHaveLength(1);
		expect(searchConversationIndex(index, 'approval').ranges).toHaveLength(1);
	});

	test('scrolls the exact match into the conversation viewport', () => {
		const viewport = document.createElement('div');
		viewport.getBoundingClientRect = () => new DOMRect(0, 0, 500, 500);
		const scrolls: ScrollToOptions[] = [];
		viewport.scrollBy = (options?: ScrollToOptions | number, y?: number) => {
			if (typeof options === 'number') {
				scrolls.push({left: options, top: y});
				return;
			}
			scrolls.push(options ?? {});
		};
		const range = document.createRange();
		Object.defineProperty(range, 'getBoundingClientRect', {
			value: () => new DOMRect(0, 550, 10, 10),
		});

		scrollRangeIntoView(range, viewport, null, undefined);

		expect(scrolls).toEqual([{top: 60}]);
	});

	test('keeps a match below the floating search bar', () => {
		const viewport = document.createElement('div');
		viewport.getBoundingClientRect = () => new DOMRect(0, 0, 500, 500);
		const overlay = document.createElement('div');
		overlay.getBoundingClientRect = () => new DOMRect(300, 12, 180, 40);
		const scrolls: ScrollToOptions[] = [];
		viewport.scrollBy = (options?: ScrollToOptions | number, y?: number) => {
			if (typeof options === 'number') {
				scrolls.push({left: options, top: y});
				return;
			}
			scrolls.push(options ?? {});
		};
		const range = document.createRange();
		Object.defineProperty(range, 'getBoundingClientRect', {
			value: () => new DOMRect(350, 20, 50, 20),
		});

		scrollRangeIntoView(range, viewport, overlay, undefined);

		expect(scrolls).toEqual([{top: -40}]);
	});

	test('reveals a match inside horizontally scrollable rendered content', () => {
		const viewport = document.createElement('div');
		viewport.getBoundingClientRect = () => new DOMRect(0, 0, 500, 500);
		viewport.scrollBy = () => undefined;
		const message = document.createElement('div');
		const overflow = document.createElement('pre');
		overflow.textContent = 'pricing';
		message.append(overflow);
		Object.defineProperties(overflow, {
			clientWidth: {value: 200},
			scrollWidth: {value: 600},
		});
		overflow.getBoundingClientRect = () => new DOMRect(100, 0, 200, 200);
		const scrolls: ScrollToOptions[] = [];
		overflow.scrollBy = (options?: ScrollToOptions | number, y?: number) => {
			if (typeof options === 'number') {
				scrolls.push({left: options, top: y});
				return;
			}
			scrolls.push(options ?? {});
		};
		const range = document.createRange();
		const text = overflow.firstChild;
		if (!text) {
			throw new Error('Expected code text');
		}
		range.selectNodeContents(text);
		Object.defineProperty(range, 'getBoundingClientRect', {
			value: () => new DOMRect(350, 100, 20, 20),
		});

		scrollRangeIntoView(range, viewport, null, message);

		expect(scrolls).toEqual([{left: 70}]);
	});

	test('remeasures an exact match after revealing skipped content', async () => {
		const viewport = document.createElement('div');
		viewport.getBoundingClientRect = () => new DOMRect(0, 0, 500, 500);
		const scrolls: ScrollToOptions[] = [];
		viewport.scrollBy = (options?: ScrollToOptions | number, y?: number) => {
			if (typeof options === 'number') {
				scrolls.push({left: options, top: y});
				return;
			}
			scrolls.push(options ?? {});
		};
		const message = document.createElement('div');
		let reveals = 0;
		message.scrollIntoView = () => {
			reveals += 1;
		};
		const range = document.createRange();
		let measurements = 0;
		Object.defineProperty(range, 'getBoundingClientRect', {
			value: () => {
				measurements += 1;
				return measurements === 1 ? new DOMRect() : new DOMRect(0, 650, 10, 10);
			},
		});

		const cancel = scrollRangeIntoView(range, viewport, null, message);
		await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
		cancel();

		expect(reveals).toBe(1);
		expect(scrolls).toEqual([{top: 160}]);
	});
});
