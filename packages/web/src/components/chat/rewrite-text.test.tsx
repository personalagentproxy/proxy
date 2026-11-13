import {afterEach, describe, expect, test} from 'bun:test';
import {act, cleanup, render} from '@testing-library/react';

import {RewriteText} from '@/components/chat/rewrite-text';

// Long enough for any rewrite to end: at most 42 frames of 16 ms.
const REWRITTEN_MS = 1000;

function wait(ms: number) {
	return act(() => new Promise((resolve) => setTimeout(resolve, ms)));
}

// What the text shows the eye, without what is read out in its place while it is rewritten.
function shown(container: HTMLElement): string {
	const hidden = container.querySelector('[aria-hidden]');
	return (hidden ?? container).textContent ?? '';
}

describe('RewriteText', () => {
	afterEach(() => {
		cleanup();
		window.matchMedia = undefined as unknown as typeof window.matchMedia;
	});

	test('shows the text as it is when it first draws', () => {
		const {container} = render(<RewriteText text="Pricing review with Dana" />);
		expect(container.textContent).toBe('Pricing review with Dana');
		expect(container.querySelector('[data-slot="rewrite-caret"]')).toBeNull();
	});

	test('rewrites a change over a moment, taking the old text away to where they differ, with a caret, reading out the new text whole meanwhile', async () => {
		const {container, rerender} = render(<RewriteText text="Moved it to Thursday." />);
		rerender(<RewriteText text="Moved it to Friday, and told Dana." />);

		await wait(48);
		expect(container.querySelector('[data-slot="rewrite-caret"]')).toBeTruthy();
		expect(shown(container).length).toBeLessThan('Moved it to Thursday.'.length);
		expect(shown(container).startsWith('Moved it to ')).toBe(true);
		expect(container.querySelector('.sr-only')?.textContent).toBe(
			'Moved it to Friday, and told Dana.',
		);

		await wait(REWRITTEN_MS);
		expect(container.textContent).toBe('Moved it to Friday, and told Dana.');
		expect(container.querySelector('[data-slot="rewrite-caret"]')).toBeNull();
	});

	test('rewrites what stood in its place before it drew, as a message does into its title', async () => {
		const {container} = render(
			<RewriteText
				text="Renew the passport"
				from="how do i renew my passport, it runs out in feb"
			/>,
		);
		expect(container.querySelector('[data-slot="rewrite-caret"]')).toBeTruthy();
		await wait(REWRITTEN_MS);
		expect(container.textContent).toBe('Renew the passport');
	});

	test('with less motion asked for, has the new text at once', () => {
		window.matchMedia = ((query: string) => ({
			matches: query.includes('reduce'),
		})) as unknown as typeof window.matchMedia;
		const {container, rerender} = render(<RewriteText text="Moved it to Thursday." />);
		rerender(<RewriteText text="Moved it to Friday." />);
		expect(container.textContent).toBe('Moved it to Friday.');
		expect(container.querySelector('[data-slot="rewrite-caret"]')).toBeNull();
	});
});
