/// <reference types="bun" />

import {afterEach, beforeEach, describe, expect, test} from 'bun:test';
import {act, cleanup, fireEvent, render, screen, waitFor} from '@testing-library/react';
import {useState} from 'react';
import {createMemoryRouter, Link, Outlet, RouterProvider} from 'react-router';
import {useReloadOnRelease} from '@/hooks/use-reload-on-release';
import {trackWrite} from '@/lib/unsaved-work';

const realFetch = globalThis.fetch;
let serverBundle = '/assets/index-Old.js';

function pageWith(bundle: string | null) {
	document.head.querySelectorAll('script[type="module"]').forEach((script) => script.remove());
	if (!bundle) {
		return;
	}
	const script = document.createElement('script');
	script.setAttribute('type', 'module');
	script.setAttribute('src', bundle);
	document.head.appendChild(script);
}

// Around every page, as the app's root is.
function Root({reload}: {reload: () => void}) {
	useReloadOnRelease(reload);
	return <Outlet />;
}

// A page with what can hold a reload back: a chat box, a field the page filled in itself, and a
// dialog to open.
function Page() {
	const [message, setMessage] = useState('');
	const [dialogOpen, setDialogOpen] = useState(false);
	return (
		<>
			<Link to="/second">Second</Link>
			<textarea
				aria-label="Message"
				value={message}
				onChange={(event) => setMessage(event.target.value)}
			/>
			<button type="button" onClick={() => setMessage('')}>
				Send
			</button>
			<input aria-label="Name" defaultValue="Dana" />
			<button type="button" onClick={() => setDialogOpen(!dialogOpen)}>
				Dialog
			</button>
			{dialogOpen ? <div role="dialog">Rename</div> : null}
		</>
	);
}

function renderPage(reload: () => void) {
	const router = createMemoryRouter(
		[
			{
				element: <Root reload={reload} />,
				children: [
					{path: '/first', element: <Page />},
					{path: '/second', element: <p>Second page</p>},
				],
			},
		],
		{initialEntries: ['/first']},
	);
	render(<RouterProvider router={router} />);
}

// A check runs when the page comes back into view, a minute or more after the last one; the
// test moves the clock rather than waiting.
function comeBackIntoView() {
	const now = Date.now;
	Date.now = () => now() + 2 * 60 * 1000;
	act(() => {
		window.dispatchEvent(new Event('focus'));
	});
	Date.now = now;
}

// The tab going out of view or coming back, which looks again at a held reload.
function changeVisibility() {
	act(() => {
		document.dispatchEvent(new Event('visibilitychange'));
	});
}

// Lets the check for a new release answer.
async function settle() {
	await act(async () => {
		await new Promise((resolve) => setTimeout(resolve, 10));
	});
}

beforeEach(() => {
	pageWith('/assets/index-Old.js');
	globalThis.fetch = ((input: string) =>
		Promise.resolve(
			input === '/'
				? new Response(`<script type="module" src="${serverBundle}"></script>`, {
						headers: {'content-type': 'text/html'},
					})
				: new Response('', {status: 200}),
		)) as typeof fetch;
});

afterEach(() => {
	cleanup();
	globalThis.fetch = realFetch;
	pageWith(null);
});

describe('useReloadOnRelease', () => {
	test('does nothing while the server has the same release', async () => {
		serverBundle = '/assets/index-Old.js';
		let reloads = 0;
		renderPage(() => reloads++);
		comeBackIntoView();
		await settle();
		expect(reloads).toBe(0);
	});

	test('reloads at once, once, when the server has a new release', async () => {
		serverBundle = '/assets/index-New.js';
		let reloads = 0;
		renderPage(() => reloads++);
		comeBackIntoView();

		await waitFor(() => expect(reloads).toBe(1));
		changeVisibility();
		expect(reloads).toBe(1);
	});

	test('is not held back by a field the page filled in itself', async () => {
		serverBundle = '/assets/index-New.js';
		let reloads = 0;
		renderPage(() => reloads++);
		expect((screen.getByLabelText('Name') as HTMLInputElement).value).toBe('Dana');
		comeBackIntoView();

		await waitFor(() => expect(reloads).toBe(1));
	});

	test('waits while something typed is in a field, until it is sent', async () => {
		serverBundle = '/assets/index-New.js';
		let reloads = 0;
		renderPage(() => reloads++);
		fireEvent.input(screen.getByLabelText('Message'), {target: {value: 'Pricing review'}});
		comeBackIntoView();
		await settle();
		changeVisibility();
		expect(reloads).toBe(0);

		fireEvent.click(screen.getByRole('button', {name: 'Send'}));
		changeVisibility();
		expect(reloads).toBe(1);
	});

	test('waits while a dialog is open', async () => {
		serverBundle = '/assets/index-New.js';
		let reloads = 0;
		renderPage(() => reloads++);
		fireEvent.click(screen.getByRole('button', {name: 'Dialog'}));
		comeBackIntoView();
		await settle();
		expect(reloads).toBe(0);

		fireEvent.click(screen.getByRole('button', {name: 'Dialog'}));
		changeVisibility();
		expect(reloads).toBe(1);
	});

	test('waits while a write is on its way', async () => {
		serverBundle = '/assets/index-New.js';
		let reloads = 0;
		let finish = () => {};
		const write = trackWrite(
			new Promise<void>((resolve) => {
				finish = resolve;
			}),
		);
		renderPage(() => reloads++);
		comeBackIntoView();
		await settle();
		expect(reloads).toBe(0);

		finish();
		await act(async () => {
			await write;
		});
		changeVisibility();
		expect(reloads).toBe(1);
	});

	test('reloads at the next page once the typing is left behind', async () => {
		serverBundle = '/assets/index-New.js';
		let reloads = 0;
		renderPage(() => reloads++);
		fireEvent.input(screen.getByLabelText('Message'), {target: {value: 'Pricing review'}});
		comeBackIntoView();
		await settle();
		expect(reloads).toBe(0);

		fireEvent.click(screen.getByRole('link', {name: 'Second'}));
		await waitFor(() => expect(reloads).toBe(1));
	});
});
