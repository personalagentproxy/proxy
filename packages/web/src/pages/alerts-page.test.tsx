/// <reference types="bun" />

import {afterEach, describe, expect, mock, test} from 'bun:test';
import {cleanup, fireEvent, render, screen, waitFor} from '@testing-library/react';
import {Ok} from 'ts-results-es';
import {createMemoryRouter, RouterProvider} from 'react-router';
import {ThemeProvider} from '@proxy/ui/components/theme-provider';
import {TooltipProvider} from '@proxy/ui/components/tooltip';
import {DEFAULT_LOOK} from '@proxy/utils/harness';
import type {Alert} from '@proxy/contracts/alerts';
import {HumanSide} from '@/components/human-side';
import {AlertsPage} from '@/pages/alerts-page';
import {later} from '@/lib/loader-utils';
import {testHuman} from '@/test-org';

const deleteAlert = mock(async () => Ok(undefined));
mock.module('@/client/alerts-client', () => ({deleteAlert}));

afterEach(() => {
	cleanup();
});

const persona = {id: 'persona-1', name: 'General', look: DEFAULT_LOOK, color: 'blue' as const};

const alerts: Alert[] = [
	{
		id: 'alert-1',
		title: 'Mail from the bank',
		brief: 'Tell me what it says.',
		persona,
		opens: 'new_thread',
		thread: null,
		setIn: {id: 't-9', title: 'Bank follow-up'},
		at: null,
		every: null,
		split: 'per_record',
		collection: 'emails',
		connections: [{id: 'conn-a', integrationId: 'google', name: 'Google (a@example.com)'}],
		terms: ['loan', 'mortgage'],
		lastMatchedAt: null,
		createdAt: '2026-11-04T10:00:00.000Z',
	},
	{
		id: 'alert-2',
		title: 'Call Dana',
		brief: 'Remind them of the call.',
		persona,
		opens: 'this_thread',
		thread: {id: 't-1', title: 'Pricing review with Dana'},
		setIn: {id: 't-1', title: 'Pricing review with Dana'},
		at: '2026-11-05T09:00:00.000Z',
		every: null,
		split: null,
		collection: null,
		connections: [],
		terms: [],
		lastMatchedAt: null,
		createdAt: '2026-11-04T10:00:00.000Z',
	},
	{
		id: 'alert-3',
		title: 'Weekly review',
		brief: 'Sum up the week.',
		persona,
		opens: 'new_thread',
		thread: null,
		setIn: {id: 't-1', title: 'Pricing review with Dana'},
		at: '2026-11-09T08:00:00.000Z',
		every: 'every week on Monday at 9:00 (Europe/Berlin)',
		split: null,
		collection: null,
		connections: [],
		terms: [],
		lastMatchedAt: null,
		createdAt: '2026-11-04T10:00:00.000Z',
	},
];

function renderPage(listed: Alert[], at = '/acme/alerts') {
	const router = createMemoryRouter(
		[
			{
				id: 'human',
				loader: () => testHuman(),
				element: <HumanSide />,
				children: [
					{
						path: '/:org/alerts',
						loader: later(async () => ({alerts: listed})),
						element: <AlertsPage />,
					},
				],
			},
		],
		{initialEntries: [at]},
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
	test('lists each alert in a line: when it was made, when it last matched or is due, and its agent', async () => {
		renderPage(alerts);
		const bank = await screen.findByText('Mail from the bank');
		const row = bank.closest('li');
		expect(row?.textContent).toContain('Never');
		expect(row?.textContent).toContain('General');
		expect(row?.textContent).not.toContain('loan');
		expect(screen.getByText('Call Dana').closest('li')?.textContent).toContain('Due Nov 5');
	});

	test('says which thread each comes to, or that it opens a new one, and that a timed one repeats', async () => {
		renderPage(alerts);
		expect((await screen.findByText('Call Dana')).closest('li')?.textContent).toContain(
			'Pricing review with Dana',
		);
		expect(screen.getByText('Mail from the bank').closest('li')?.textContent).toContain(
			'New thread',
		);
		expect(screen.getByText('Weekly review').closest('li')?.textContent).toContain('repeats');
	});

	test('shows the alerts of the thread the address names alone, with a way back to them all', async () => {
		renderPage(alerts, '/acme/alerts?thread=t-1');
		expect(await screen.findByText('Call Dana')).toBeTruthy();
		expect(screen.queryByText('Mail from the bank')).toBeNull();
		// Set in the thread, but opening threads of its own: not one that comes to it.
		expect(screen.queryByText('Weekly review')).toBeNull();
		expect(screen.getByText(/Alerts of the thread/).textContent).toContain(
			'Pricing review with Dana',
		);
		expect(
			screen.getByRole('link', {name: '“Pricing review with Dana”'}).getAttribute('href'),
		).toBe(`/acme/chat/${persona.id}/threads/t-1`);
		fireEvent.click(screen.getByRole('button', {name: 'Show all'}));
		expect(await screen.findByText('Mail from the bank')).toBeTruthy();
		expect(screen.getByText('Weekly review')).toBeTruthy();
	});

	test('shows the alerts of the chat the address names that open threads of their own alone', async () => {
		renderPage(alerts, `/acme/alerts?chat=${persona.id}`);
		expect(await screen.findByText('Mail from the bank')).toBeTruthy();
		expect(screen.getByText('Weekly review')).toBeTruthy();
		// One that comes to a thread of the chat is the thread's.
		expect(screen.queryByText('Call Dana')).toBeNull();
		expect(screen.getByText(/Alerts that open threads in the chat with/).textContent).toContain(
			persona.name,
		);
		expect(screen.getByRole('link', {name: persona.name}).getAttribute('href')).toBe(
			`/acme/chat/${persona.id}`,
		);
		fireEvent.click(screen.getByRole('button', {name: 'Show all'}));
		expect(await screen.findByText('Call Dana')).toBeTruthy();
	});

	test('says none opens threads in the chat the address names once none does', async () => {
		renderPage(alerts, '/acme/alerts?chat=someone-else');
		expect(await screen.findByText('No alerts open threads in this chat.')).toBeTruthy();
	});

	test('says none comes to the thread the address names once none does', async () => {
		renderPage(alerts, '/acme/alerts?thread=t-gone');
		expect(await screen.findByText('No alerts come to this thread.')).toBeTruthy();
	});

	test('a row opens the alert in full: what it watches, its words, the note and a link to the conversation', async () => {
		renderPage(alerts);
		const row = (await screen.findByText('Mail from the bank')).closest('button');
		expect(row).not.toBeNull();
		fireEvent.click(row as HTMLElement);
		const dialog = await screen.findByRole('dialog');
		expect(dialog.textContent).toContain('Google (a@example.com)');
		expect(dialog.textContent).toContain('loan');
		expect(dialog.textContent).toContain('mortgage');
		expect(dialog.textContent).toContain('Tell me what it says.');
		expect(dialog.textContent).toContain('A new thread each time');
		expect(dialog.textContent).toContain('A thread for each record');
		const link = (name: string) =>
			[...dialog.querySelectorAll('a')].find((a) => a.textContent === name)?.getAttribute('href');
		expect(link('General')).toBe('/acme/chat/persona-1');
		expect(link('Bank follow-up')).toBe('/acme/chat/persona-1/threads/t-9');
	});

	test('a timed alert in full links to the thread it comes to, and one that repeats says how', async () => {
		renderPage(alerts);
		fireEvent.click((await screen.findByText('Call Dana')).closest('button') as HTMLElement);
		const dialog = await screen.findByRole('dialog');
		const comes = [...dialog.querySelectorAll('a')].find(
			(a) => a.textContent === 'Pricing review with Dana',
		);
		expect(comes?.getAttribute('href')).toBe('/acme/chat/persona-1/threads/t-1');
		// Set where it comes: said once.
		expect(dialog.textContent).not.toContain('Set in');
		fireEvent.keyDown(dialog, {key: 'Escape'});
		await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
		fireEvent.click(screen.getByText('Weekly review').closest('button') as HTMLElement);
		const weekly = await screen.findByRole('dialog');
		expect(weekly.textContent).toContain('every week on Monday at 9:00 (Europe/Berlin)');
		expect(weekly.textContent).toContain('Set in');
	});

	test('deleting one asks first, then deletes it', async () => {
		renderPage(alerts);
		fireEvent.click(await screen.findByRole('button', {name: 'Delete Call Dana'}));
		fireEvent.click(await screen.findByRole('button', {name: 'Delete'}));
		expect(deleteAlert).toHaveBeenCalledWith('acme', 'alert-2');
	});

	test('says what to do when none is set', async () => {
		renderPage([]);
		expect((await screen.findByText(/No alerts set/)).textContent).toContain(
			'Ask an agent in Chat',
		);
	});
});
