import {afterEach, describe, expect, test} from 'bun:test';
import {act, cleanup, render} from '@testing-library/react';

import {SlideText} from '@/components/chat/slide-text';

function wait(ms: number) {
	return act(() => new Promise((resolve) => setTimeout(resolve, ms)));
}

const leaving = (container: HTMLElement) =>
	container.querySelector('[data-slot="slide-text-leaving"]');

describe('SlideText', () => {
	afterEach(() => {
		cleanup();
		window.matchMedia = undefined as unknown as typeof window.matchMedia;
	});

	test('shows the text as it is when it first draws, nothing sliding', () => {
		const {container} = render(<SlideText text="Pricing review with Dana" />);
		expect(container.textContent).toBe('Pricing review with Dana');
		expect(leaving(container)).toBeNull();
	});

	test('slides a change in from below as what it said slides out above, hidden from what reads the page, then shows the new text alone', async () => {
		const {container, getByText, rerender} = render(<SlideText text="Moved it to Thursday." />);
		rerender(<SlideText text="Moved it to Friday, and told Dana." />);

		expect(leaving(container)?.textContent).toBe('Moved it to Thursday.');
		expect(leaving(container)?.getAttribute('aria-hidden')).toBe('true');
		expect(leaving(container)?.className).toContain('slide-out-to-top-full');
		expect(getByText('Moved it to Friday, and told Dana.').className).toContain(
			'slide-in-from-bottom-full',
		);

		await wait(400);
		expect(leaving(container)).toBeNull();
		expect(container.textContent).toBe('Moved it to Friday, and told Dana.');
	});

	test('slides from what stood in its place before it drew, as a message does into its title', async () => {
		const {container} = render(
			<SlideText text="Renew the passport" from="how do i renew my passport, it runs out in feb" />,
		);
		expect(leaving(container)?.textContent).toBe('how do i renew my passport, it runs out in feb');
		await wait(400);
		expect(container.textContent).toBe('Renew the passport');
	});

	test('with less motion asked for, has the new text at once', () => {
		window.matchMedia = ((query: string) => ({
			matches: query.includes('reduce'),
		})) as unknown as typeof window.matchMedia;
		const {container, rerender} = render(<SlideText text="Moved it to Thursday." />);
		rerender(<SlideText text="Moved it to Friday." />);
		expect(leaving(container)).toBeNull();
		expect(container.textContent).toBe('Moved it to Friday.');
	});
});
