/// <reference types="bun" />

import {afterEach, describe, expect, test} from 'bun:test';
import {cleanup, fireEvent, render, screen, waitFor} from '@testing-library/react';
import {createMemoryRouter, RouterProvider} from 'react-router';
import {TooltipProvider} from '@proxy/ui/components/tooltip';
import {ThemeProvider} from '@proxy/ui/components/theme-provider';
import {HumanSide} from '@/components/human-side';
import {VaultPage} from '@/pages/vault-page';

afterEach(() => {
	cleanup();
});

function renderVaultPage(entries: Array<{id: string; values: Record<string, string>}>) {
	const router = createMemoryRouter(
		[
			{
				id: 'human',
				loader: () => ({
					user: {id: 'user-1', email: 'person@example.com', name: null, image: null},
					onboarded: true,
				}),
				element: <HumanSide />,
				children: [
					{
						path: '/vault',
						loader: () => ({
							connectionId: 'vault-1',
							entries: entries.map((entry) => ({...entry, updatedAt: '2026-10-21T00:00:00.000Z'})),
						}),
						element: <VaultPage />,
					},
				],
			},
		],
		{initialEntries: ['/vault']},
	);

	return render(
		<ThemeProvider>
			<TooltipProvider>
				<RouterProvider router={router} />
			</TooltipProvider>
		</ThemeProvider>,
	);
}

describe('VaultPage', () => {
	test('lists each entry by its title, with its type and the first line of its content', async () => {
		renderVaultPage([
			{id: 'entry-1', values: {title: 'Home', type: 'Address', content: '1 Main St\n10115 Berlin'}},
		]);

		const row = await screen.findByRole('button', {name: /Home/});
		expect(row.textContent).toContain('Address');
		expect(row.textContent).toContain('1 Main St');
		expect(row.textContent).not.toContain('Berlin');
	});

	test('says what the vault is for while it is empty', async () => {
		renderVaultPage([]);

		expect(await screen.findByText(/let them keep what they learn/)).toBeDefined();
	});

	test('a new entry needs something written, its type alone is not enough', async () => {
		renderVaultPage([{id: 'entry-1', values: {title: 'Phone', type: 'Phone number', content: ''}}]);

		fireEvent.click(await screen.findByRole('button', {name: 'Add entry'}));
		const save = await screen.findByRole('button', {name: 'Save'});
		expect(save).toHaveProperty('disabled', true);
		fireEvent.change(screen.getByLabelText('Title'), {target: {value: 'Shoe size'}});
		expect(save).toHaveProperty('disabled', false);
		fireEvent.click(screen.getByRole('button', {name: 'Cancel'}));
		await waitFor(() => expect(screen.queryByRole('button', {name: 'Save'})).toBeNull());

		fireEvent.click(screen.getByRole('button', {name: /Phone/}));
		expect(await screen.findByRole('button', {name: 'Save'})).toHaveProperty('disabled', false);
	});
});
