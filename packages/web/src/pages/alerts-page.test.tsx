/// <reference types="bun" />

import type {Alert} from '@proxy/contracts/alerts';
import {ThemeProvider} from '@proxy/ui/components/theme-provider';
import {TooltipProvider} from '@proxy/ui/components/tooltip';
import {afterEach, beforeEach, describe, expect, mock, test} from 'bun:test';
import {cleanup, fireEvent, render, screen} from '@testing-library/react';
import {createMemoryRouter, RouterProvider} from 'react-router';
import {HumanSide} from '@/components/human-side';
import {AlertsPage} from '@/pages/alerts-page';
import {testHuman} from '@/test-org';

const realFetch = globalThis.fetch;
const fetchMock = mock<(input: string, init?: RequestInit) => Promise<Response>>();
const look = {nose: 0.48, noseOut: 0.35, eye: 27, eyeTheta: 55, eyeLat: 8, eyes: 2 as const};

function alert(extra: Partial<Alert>): Alert {
	return {
		id: 'alert-1',
		title: 'Mail from the bank',
		brief: 'Mail from the bank about the loan.',
		persona: {id: 'finance', name: 'Finance', look, color: 'blue'},
		at: null,
		collectionId: 'emails',
		criteria: [{field: 'from', terms: ['@bank.com']}],
		connections: [
			{id: 'c1', name: 'Gmail (a@example.com)'},
			{id: 'c2', name: 'Work mail'},
		],
		lastPolledAt: '2026-11-03T09:50:00.000Z',
		pollError: null,
		matchCount: 1,
		matches: [
			{
				id: 'm1',
				title: 'Your loan',
				summary: 'from: dana@bank.com',
				url: 'https://mail.example/m1',
				at: '2026-11-03T09:40:00.000Z',
			},
		],
		endedAt: null,
		endedBy: null,
		createdAt: '2026-11-03T09:00:00.000Z',
		...extra,
	};
}

const watch = alert({});
const fired = alert({
	id: 'alert-2',
	title: 'Dentist',
	brief: 'Leave at 8.',
	at: '2026-11-02T08:30:00.000Z',
	collectionId: null,
	criteria: [],
	connections: [],
	lastPolledAt: null,
	matchCount: 0,
	matches: [],
	endedAt: '2026-11-02T08:30:00.000Z',
	endedBy: 'fired',
});

beforeEach(() => {
	fetchMock.mockReset();
	fetchMock.mockImplementation(() => Promise.resolve(new Response(null, {status: 204})));
	globalThis.fetch = ((input: string, init?: RequestInit) =>
		fetchMock(input, init)) as typeof fetch;
});

afterEach(() => {
	cleanup();
	globalThis.fetch = realFetch;
});

function renderAlertsPage(alerts: Alert[]) {
	let loads = 0;
	const router = createMemoryRouter(
		[
			{
				id: 'human',
				loader: () => testHuman(),
				element: <HumanSide />,
				children: [
					{
						path: '/:org/alerts',
						loader: () => {
							loads += 1;
							return {alerts: loads === 1 ? alerts : alerts.slice(1)};
						},
						element: <AlertsPage />,
					},
				],
			},
		],
		{initialEntries: ['/acme/alerts']},
	);

	return render(
		<ThemeProvider>
			<TooltipProvider>
				<RouterProvider router={router} />
			</TooltipProvider>
		</ThemeProvider>,
	);
}

describe('AlertsPage', () => {
	test('lists the alerts going on first, each with its schedule, its brief and the agent, then those ended, with how', async () => {
		renderAlertsPage([fired, watch]);
		const rows = await screen.findAllByRole('link', {name: /Mail from the bank|Dentist/});
		expect(rows.map((row) => row.getAttribute('href'))).toEqual([
			'/acme/chat/finance',
			'/acme/chat/finance',
		]);
		expect(rows[0]?.textContent).toContain('Mail from the bank');
		expect(rows[0]?.textContent).toContain(
			'Emails in Gmail (a@example.com) and Work mail, for from contains “@bank.com”',
		);
		expect(rows[0]?.textContent).toContain('Matched 1 time');
		expect(rows[0]?.textContent).toContain('Your loan · from: dana@bank.com');
		expect(rows[0]?.textContent).toContain('Watching');
		expect(rows[1]?.textContent).toContain('Dentist');
		expect(rows[1]?.textContent).toContain('Fired ');
		expect(rows[1]?.textContent).toContain('Ended');
		expect(screen.getByText('1 active')).toBeTruthy();
	});

	test('says what to do when there are none', async () => {
		renderAlertsPage([]);
		await screen.findByText(/No alerts yet/);
	});

	test('deletes an alert after confirming', async () => {
		// The delete, as the api is asked for it: waited for as such, since the list is read again
		// as soon as it is answered, and waiting on the page meanwhile holds that read up in turn.
		const deleted = new Promise<[string, RequestInit | undefined]>((resolve) => {
			fetchMock.mockImplementation((input, init) => {
				if (init?.method === 'DELETE') {
					resolve([input, init]);
				}
				return Promise.resolve(new Response(null, {status: 204}));
			});
		});
		renderAlertsPage([watch, fired]);
		fireEvent.click(await screen.findByRole('button', {name: 'Delete Mail from the bank'}));
		expect(
			await screen.findByRole('heading', {name: 'Delete “Mail from the bank”?'}),
		).toBeDefined();
		fireEvent.click(screen.getByRole('button', {name: 'Delete'}));

		const [path, init] = await deleted;
		expect(path).toBe('/api/orgs/acme/alerts/alert-1');
		expect(init?.method).toBe('DELETE');
	});
});
