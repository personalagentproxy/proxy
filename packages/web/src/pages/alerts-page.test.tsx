/// <reference types="bun" />

import {afterEach, describe, expect, mock, test} from 'bun:test';
import {cleanup, fireEvent, render, screen} from '@testing-library/react';
import {Ok} from 'ts-results-es';
import {createMemoryRouter, RouterProvider} from 'react-router';
import {ThemeProvider} from '@proxy/ui/components/theme-provider';
import {TooltipProvider} from '@proxy/ui/components/tooltip';
import {DEFAULT_LOOK} from '@proxy/utils/harness';
import type {Alert} from '@proxy/contracts/alerts';
import {HumanSide} from '@/components/human-side';
import {AlertsPage} from '@/pages/alerts-page';
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
		at: null,
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
		at: '2026-11-05T09:00:00.000Z',
		collection: null,
		connections: [],
		terms: [],
		lastMatchedAt: null,
		createdAt: '2026-11-04T10:00:00.000Z',
	},
];

function renderPage(listed: Alert[]) {
	const router = createMemoryRouter(
		[
			{
				id: 'human',
				loader: () => testHuman(),
				element: <HumanSide />,
				children: [
					{path: '/:org/alerts', loader: () => ({alerts: listed}), element: <AlertsPage />},
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
	test('lists each alert in a line: when it was made, when it last matched or is due, and its agent', async () => {
		renderPage(alerts);
		const bank = await screen.findByText('Mail from the bank');
		const row = bank.closest('li');
		expect(row?.textContent).toContain('Never');
		expect(row?.textContent).toContain('General');
		expect(row?.textContent).not.toContain('loan');
		expect(screen.getByText('Call Dana').closest('li')?.textContent).toContain('Due Nov 5');
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
		expect(dialog.querySelector('a')?.getAttribute('href')).toBe('/acme/chat/persona-1');
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
