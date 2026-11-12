import {afterEach, describe, expect, spyOn, test} from 'bun:test';
import {cleanup, fireEvent, render, screen, waitFor} from '@testing-library/react';
import {createMemoryRouter, RouterProvider} from 'react-router';
import type {Connection} from '@proxy/contracts/connections';
import {ConnectionHealthPanel} from './connection-health';
import {useConnectionHealth} from '@/hooks/use-connection-health';

const connection: Connection = {
	id: 'connection-1',
	orgId: 'org-1',
	integrationId: 'mcp',
	account: 'mcp.example.com/mcp',
	ownerUserId: 'user-1',
	owner: 'Alex',
	sharedWithEveryone: false,
	sharedWith: [],
	shared: false,
	builtIn: false,
	defaults: [],
	tools: [],
	name: 'Example service',
	unavailable: [],
	signInNeeded: false,
};

afterEach(() => {
	cleanup();
});

const recentHealth = {
	status: 'healthy' as const,
	checkedAt: new Date().toISOString(),
	message: 'The provider responded to a live connection check.',
};

function show(mayChange = true, health = recentHealth) {
	const router = createMemoryRouter(
		[
			{
				path: '/:org/connections/:connectionId',
				element: (
					<ConnectionHealthPanel connection={{...connection, health}} mayChange={mayChange} />
				),
			},
		],
		{initialEntries: ['/acme/connections/connection-1']},
	);
	render(<RouterProvider router={router} />);
}

describe('connection health panel', () => {
	test('reuses a recent saved result and offers reconnection when credentials are rejected', async () => {
		const fetch = spyOn(globalThis, 'fetch').mockResolvedValue(
			new Response(
				JSON.stringify({
					status: 'sign_in_required',
					checkedAt: '2026-01-01T12:00:00.000Z',
					message: 'The provider rejected the saved credentials.',
				}),
				{headers: {'content-type': 'application/json'}},
			),
		);
		try {
			show();
			expect(screen.getByText('Healthy')).toBeTruthy();
			expect(fetch).not.toHaveBeenCalled();
			fireEvent.click(screen.getByRole('button', {name: 'Check connection'}));
			await screen.findByText('Sign in required');
			expect(fetch.mock.calls[0]?.[0]).toBe('/api/orgs/acme/connections/connection-1/health');
			expect(fetch.mock.calls[0]?.[1]?.method).toBe('POST');
			const href = screen.getByRole('link', {name: 'Reconnect'}).getAttribute('href')!;
			const url = new URL(href, 'http://localhost');
			expect(url.pathname).toBe('/acme/connections/new/mcp');
			expect(url.searchParams.get('url')).toBe('https://mcp.example.com/mcp');
			expect(url.searchParams.get('name')).toBe('Example service');
		} finally {
			fetch.mockRestore();
		}
	});

	test('refreshes a saved health result after it becomes stale', async () => {
		const fetch = spyOn(globalThis, 'fetch').mockResolvedValue(
			new Response(
				JSON.stringify({
					status: 'healthy',
					checkedAt: new Date().toISOString(),
					message: 'The provider responded to a live connection check.',
				}),
				{headers: {'content-type': 'application/json'}},
			),
		);
		try {
			show(true, {...recentHealth, checkedAt: '2026-01-01T12:00:00.000Z'});
			await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
			expect(fetch.mock.calls[0]?.[0]).toBe('/api/orgs/acme/connections/connection-1/health');
			expect(fetch.mock.calls[0]?.[1]?.method).toBe('POST');
		} finally {
			fetch.mockRestore();
		}
	});

	test('shared users can check but cannot reconnect the owner’s account', async () => {
		const fetch = spyOn(globalThis, 'fetch').mockResolvedValue(
			new Response(
				JSON.stringify({
					status: 'sign_in_required',
					checkedAt: '2026-01-01T12:00:00.000Z',
					message: 'Sign in again.',
				}),
				{headers: {'content-type': 'application/json'}},
			),
		);
		try {
			show(false);
			fireEvent.click(screen.getByRole('button', {name: 'Check connection'}));
			await screen.findByText('Ask the connection owner to reconnect.');
			expect(screen.queryByRole('link', {name: 'Reconnect'})).toBeNull();
		} finally {
			fetch.mockRestore();
		}
	});

	test('a failed request never becomes a healthy result and can be retried', async () => {
		const fetch = spyOn(globalThis, 'fetch').mockResolvedValue(
			new Response('{}', {status: 500, headers: {'content-type': 'application/json'}}),
		);
		try {
			show();
			fireEvent.click(screen.getByRole('button', {name: 'Check connection'}));
			await screen.findByText('Check failed');
			await waitFor(() =>
				expect(
					screen.getByRole('button', {name: 'Check connection'}).hasAttribute('disabled'),
				).toBe(false),
			);
			expect(screen.queryByText('Healthy')).toBeNull();
		} finally {
			fetch.mockRestore();
		}
	});
});

test('checking a list limits concurrent provider requests and reports every result', async () => {
	const pending: Array<() => void> = [];
	let active = 0;
	let maximum = 0;
	const respond = async () => {
		active += 1;
		maximum = Math.max(maximum, active);
		return await new Promise<Response>((resolve) =>
			pending.push(() => {
				active -= 1;
				resolve(
					new Response(
						JSON.stringify({
							status: 'healthy',
							checkedAt: '2026-01-01T12:00:00.000Z',
							message: 'Provider responded.',
						}),
						{headers: {'content-type': 'application/json'}},
					),
				);
			}),
		);
	};
	const fetch = spyOn(globalThis, 'fetch').mockImplementation(
		Object.assign(respond, {preconnect: globalThis.fetch.preconnect}),
	);
	function Checks() {
		const {checkMany, results} = useConnectionHealth('acme');
		return (
			<>
				<button
					onClick={() => void checkMany(Array.from({length: 8}, (_, i) => `connection-${i}`))}
				>
					Check connections
				</button>
				<output>{Object.keys(results).length} checked</output>
			</>
		);
	}
	try {
		render(<Checks />);
		fireEvent.click(screen.getByRole('button', {name: 'Check connections'}));
		await waitFor(() => expect(fetch).toHaveBeenCalledTimes(3));
		// A second click cannot start another batch over the running one.
		fireEvent.click(screen.getByRole('button', {name: 'Check connections'}));
		expect(fetch).toHaveBeenCalledTimes(3);
		pending.splice(0).forEach((resolve) => resolve());
		await waitFor(() => expect(fetch).toHaveBeenCalledTimes(6));
		pending.splice(0).forEach((resolve) => resolve());
		await waitFor(() => expect(fetch).toHaveBeenCalledTimes(8));
		pending.splice(0).forEach((resolve) => resolve());
		await screen.findByText('8 checked');
		expect(maximum).toBe(3);
	} finally {
		pending.splice(0).forEach((resolve) => resolve());
		fetch.mockRestore();
	}
});
