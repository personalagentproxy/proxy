/// <reference types="bun" />

import {afterEach, beforeEach, describe, expect, test} from 'bun:test';
import {act, cleanup, fireEvent, render, screen} from '@testing-library/react';
import {useState} from 'react';
import {createMemoryRouter, Link, Outlet, RouterProvider} from 'react-router';
import {useReloadOnRelease, useReloadWhileHidden} from '@/hooks/use-reload-on-release';
import {trackWrite} from '@/lib/writes-in-flight';

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

// A page that says a reload loses it nothing until something is typed in its box.
function Page() {
	const [message, setMessage] = useState('');
	useReloadWhileHidden(message === '');
	return (
		<>
			<Link to="/second">Second</Link>
			<textarea
				aria-label="Message"
				value={message}
				onChange={(event) => setMessage(event.target.value)}
			/>
		</>
	);
}

// A page that says nothing of reloads.
function SecondPage() {
	return <Link to="/first">First</Link>;
}

// A box that says a reload loses it nothing until something is typed in it.
function Box({label}: {label: string}) {
	const [message, setMessage] = useState('');
	useReloadWhileHidden(message === '');
	return (
		<textarea
			aria-label={label}
			value={message}
			onChange={(event) => setMessage(event.target.value)}
		/>
	);
}

// A page of two parts that each say so, as a chat and the thread open beside it.
function TwoBoxPage() {
	return (
		<>
			<Box label="Message" />
			<Box label="Reply" />
		</>
	);
}

function renderPage(reload: () => void, at = '/first') {
	const router = createMemoryRouter(
		[
			{
				element: <Root reload={reload} />,
				children: [
					{path: '/first', element: <Page />},
					{path: '/second', element: <SecondPage />},
					{path: '/both', element: <TwoBoxPage />},
				],
			},
		],
		{initialEntries: [at]},
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

let visibility: DocumentVisibilityState = 'visible';

// The tab going out of view or coming back.
function setVisibility(next: DocumentVisibilityState) {
	visibility = next;
	act(() => {
		document.dispatchEvent(new Event('visibilitychange'));
	});
}

// A page found to be behind the server's release, while in view.
async function findNewRelease() {
	serverBundle = '/assets/index-New.js';
	comeBackIntoView();
	await settle();
}

async function goTo(name: string) {
	fireEvent.click(screen.getByRole('link', {name}));
	await settle();
}

// A write on its way until the returned function is called.
function startWrite(): () => Promise<void> {
	let finish = () => {};
	const write = trackWrite(
		new Promise<void>((resolve) => {
			finish = resolve;
		}),
	);
	return async () => {
		finish();
		await act(async () => {
			await write;
		});
	};
}

// Lets the check for a new release answer.
async function settle() {
	await act(async () => {
		await new Promise((resolve) => setTimeout(resolve, 10));
	});
}

beforeEach(() => {
	visibility = 'visible';
	Object.defineProperty(document, 'visibilityState', {configurable: true, get: () => visibility});
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
	Reflect.deleteProperty(document, 'visibilityState');
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
		await goTo('Second');
		setVisibility('hidden');
		expect(reloads).toBe(0);
	});

	test('reloads at the next page, once, not in front of the person', async () => {
		let reloads = 0;
		renderPage(() => reloads++);
		await findNewRelease();
		expect(reloads).toBe(0);

		await goTo('Second');
		expect(reloads).toBe(1);
		await goTo('First');
		expect(reloads).toBe(1);
	});

	test('reloads at the next page even with something typed on the last one', async () => {
		let reloads = 0;
		renderPage(() => reloads++);
		fireEvent.change(screen.getByLabelText('Message'), {target: {value: 'Pricing review'}});
		await findNewRelease();

		await goTo('Second');
		expect(reloads).toBe(1);
	});

	test('waits for the page after the next while a write is on its way', async () => {
		let reloads = 0;
		renderPage(() => reloads++);
		await findNewRelease();
		const finish = startWrite();
		await goTo('Second');
		expect(reloads).toBe(0);

		await finish();
		await goTo('First');
		expect(reloads).toBe(1);
	});

	test('reloads out of view a page that says it loses nothing', async () => {
		let reloads = 0;
		renderPage(() => reloads++);
		await findNewRelease();
		expect(reloads).toBe(0);

		setVisibility('hidden');
		expect(reloads).toBe(1);
	});

	test('does not reload out of view a page that says nothing', async () => {
		let reloads = 0;
		renderPage(() => reloads++);
		await goTo('Second');
		await findNewRelease();

		setVisibility('hidden');
		expect(reloads).toBe(0);
	});

	test('does not reload out of view a page once it holds something', async () => {
		let reloads = 0;
		renderPage(() => reloads++);
		fireEvent.change(screen.getByLabelText('Message'), {target: {value: 'Pricing review'}});
		await findNewRelease();

		setVisibility('hidden');
		expect(reloads).toBe(0);
	});

	test('does not reload out of view a page one part of which holds something, whatever the others say', async () => {
		let reloads = 0;
		renderPage(() => reloads++, '/both');
		fireEvent.change(screen.getByLabelText('Reply'), {target: {value: 'Pricing review'}});
		await findNewRelease();

		setVisibility('hidden');
		expect(reloads).toBe(0);

		setVisibility('visible');
		fireEvent.change(screen.getByLabelText('Reply'), {target: {value: ''}});
		setVisibility('hidden');
		expect(reloads).toBe(1);
	});

	test('reloads out of view once a write on its way has landed', async () => {
		let reloads = 0;
		renderPage(() => reloads++);
		await findNewRelease();
		const finish = startWrite();
		setVisibility('hidden');
		expect(reloads).toBe(0);

		await finish();
		setVisibility('hidden');
		expect(reloads).toBe(1);
	});
});
