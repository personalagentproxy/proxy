/// <reference types="bun" />

import {afterEach, beforeEach, describe, expect, test} from 'bun:test';
import {act, cleanup, fireEvent, render, screen, waitFor} from '@testing-library/react';
import {createMemoryRouter, Link, RouterProvider} from 'react-router';
import {ReleaseNotice} from '@/components/release-notice';

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

function renderNotice(reload: () => void) {
	const router = createMemoryRouter(
		[
			{
				path: '/:page',
				element: (
					<>
						<Link to="/second">Second</Link>
						<ReleaseNotice reload={reload} />
					</>
				),
			},
		],
		{initialEntries: ['/first']},
	);
	render(<RouterProvider router={router} />);
	return router;
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

beforeEach(() => {
	pageWith('/assets/index-Old.js');
	globalThis.fetch = ((_input: string, _init?: RequestInit) =>
		Promise.resolve(
			new Response(`<script type="module" src="${serverBundle}"></script>`, {
				headers: {'content-type': 'text/html'},
			}),
		)) as typeof fetch;
});

afterEach(() => {
	cleanup();
	globalThis.fetch = realFetch;
	pageWith(null);
	delete window.personalAgentProxyDesktop;
});

// The desktop app's window, with an update downloaded.
function desktopWith(version: string | null, restart: () => void) {
	window.personalAgentProxyDesktop = {
		updateReady: () => Promise.resolve(version),
		onUpdateReady: () => () => {},
		restart,
	};
}

describe('ReleaseNotice', () => {
	test('shows nothing while the server has the same release', async () => {
		serverBundle = '/assets/index-Old.js';
		renderNotice(() => {});
		comeBackIntoView();
		await act(async () => {});
		expect(screen.queryByRole('status')).toBeNull();
	});

	test('offers a reload once the server has a new release', async () => {
		serverBundle = '/assets/index-New.js';
		let reloads = 0;
		renderNotice(() => reloads++);
		comeBackIntoView();

		await waitFor(() => expect(screen.getByRole('status')).toBeTruthy());
		fireEvent.click(screen.getByRole('button', {name: 'Reload'}));
		expect(reloads).toBe(1);
	});

	test('offers a restart in the desktop app with an update downloaded', async () => {
		serverBundle = '/assets/index-Old.js';
		let restarts = 0;
		desktopWith('0.0.2', () => restarts++);
		renderNotice(() => {});

		await waitFor(() => expect(screen.getByRole('status')).toBeTruthy());
		fireEvent.click(screen.getByRole('button', {name: 'Restart'}));
		expect(restarts).toBe(1);
	});

	test('offers the restart over a reload, which the restart includes', async () => {
		serverBundle = '/assets/index-New.js';
		desktopWith('0.0.2', () => {});
		renderNotice(() => {});
		comeBackIntoView();

		await waitFor(() => expect(screen.getByRole('button', {name: 'Restart'})).toBeTruthy());
		expect(screen.queryByRole('button', {name: 'Reload'})).toBeNull();
	});

	test('shows nothing in the desktop app without an update', async () => {
		serverBundle = '/assets/index-Old.js';
		desktopWith(null, () => {});
		renderNotice(() => {});
		await act(async () => {});
		expect(screen.queryByRole('status')).toBeNull();
	});

	test('dismissed, goes, and still reloads at the next page', async () => {
		serverBundle = '/assets/index-New.js';
		let reloads = 0;
		renderNotice(() => reloads++);
		comeBackIntoView();
		await waitFor(() => expect(screen.getByRole('status')).toBeTruthy());

		fireEvent.click(screen.getByRole('button', {name: 'Dismiss'}));
		expect(screen.queryByRole('status')).toBeNull();
		expect(reloads).toBe(0);

		fireEvent.click(screen.getByRole('link', {name: 'Second'}));
		await waitFor(() => expect(reloads).toBe(1));
	});

	test('dismissed in the desktop app, goes without restarting', async () => {
		serverBundle = '/assets/index-Old.js';
		let restarts = 0;
		desktopWith('0.0.2', () => restarts++);
		renderNotice(() => {});
		await waitFor(() => expect(screen.getByRole('status')).toBeTruthy());

		fireEvent.click(screen.getByRole('button', {name: 'Dismiss'}));
		expect(screen.queryByRole('status')).toBeNull();
		expect(restarts).toBe(0);
	});

	test('reloads at the next page instead, when left alone', async () => {
		serverBundle = '/assets/index-New.js';
		let reloads = 0;
		renderNotice(() => reloads++);
		comeBackIntoView();
		await waitFor(() => expect(screen.getByRole('status')).toBeTruthy());
		expect(reloads).toBe(0);

		fireEvent.click(screen.getByRole('link', {name: 'Second'}));
		await waitFor(() => expect(reloads).toBe(1));
	});
});
