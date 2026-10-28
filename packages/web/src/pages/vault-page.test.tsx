/// <reference types="bun" />

import {afterEach, describe, expect, test} from 'bun:test';
import {cleanup, fireEvent, render, screen, waitFor} from '@testing-library/react';
import {createMemoryRouter, RouterProvider} from 'react-router';
import {TooltipProvider} from '@proxy/ui/components/tooltip';
import {ThemeProvider} from '@proxy/ui/components/theme-provider';
import {HumanSide} from '@/components/human-side';
import type {Org} from '@/client/orgs-client';
import {VaultPage} from '@/pages/vault-page';
import {testHuman, testOrg} from '@/test-org';

afterEach(() => {
	cleanup();
});

type Entry = {id: string; values: Record<string, string>};

function vault(connectionId: string, entries: Entry[]) {
	return {
		connectionId,
		entries: entries.map((entry) => ({...entry, updatedAt: '2026-10-21T00:00:00.000Z'})),
	};
}

// The person's own vault with the entries, and the organization's with `shared`; alone in the
// organization unless `org` says otherwise.
function renderVaultPage(entries: Entry[], options: {shared?: Entry[]; org?: Org} = {}) {
	const org = options.org ?? testOrg;
	const router = createMemoryRouter(
		[
			{
				id: 'human',
				loader: () => testHuman(org),
				element: <HumanSide />,
				children: [
					{
						path: '/:org/connections/vault',
						loader: () => ({
							own: vault('vault-1', entries),
							shared: vault('vault-2', options.shared ?? []),
						}),
						element: <VaultPage />,
					},
				],
			},
		],
		{initialEntries: ['/acme/connections/vault']},
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

	test("alone in the organization, the organization's vault's entries are listed with the person's own", async () => {
		renderVaultPage(
			[{id: 'entry-1', values: {title: 'Home', type: 'Address', content: '1 Main St'}}],
			{
				shared: [{id: 'entry-2', values: {title: 'Office', type: 'Address', content: '2 Side St'}}],
			},
		);

		expect(await screen.findByRole('button', {name: /Home/})).toBeDefined();
		expect(screen.getByRole('button', {name: /Office/})).toBeDefined();
		expect(screen.queryByRole('button', {name: /Everyone in Acme/})).toBeNull();
	});

	test("with others in the organization, a toggle picks the person's own vault or the organization's", async () => {
		renderVaultPage(
			[{id: 'entry-1', values: {title: 'Home', type: 'Address', content: '1 Main St'}}],
			{
				shared: [{id: 'entry-2', values: {title: 'Office', type: 'Address', content: '2 Side St'}}],
				org: {...testOrg, memberCount: 2},
			},
		);

		expect(await screen.findByRole('button', {name: /Home/})).toBeDefined();
		expect(screen.queryByRole('button', {name: /Office/})).toBeNull();

		fireEvent.click(screen.getByRole('button', {name: /Everyone in Acme/}));
		expect(await screen.findByRole('button', {name: /Office/})).toBeDefined();
		expect(screen.queryByRole('button', {name: /Home/})).toBeNull();
	});

	test("the organization's vault says what it is for while it is empty", async () => {
		renderVaultPage([], {org: {...testOrg, memberCount: 2}});

		fireEvent.click(await screen.findByRole('button', {name: /Everyone in Acme/}));
		expect(await screen.findByText(/everyone's agents should know about Acme/)).toBeDefined();
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
