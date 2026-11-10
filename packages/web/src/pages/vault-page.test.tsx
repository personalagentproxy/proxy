/// <reference types="bun" />

import type {Connection} from '@proxy/contracts/connections';
import type {DataRecord} from '@proxy/contracts/records';
import {afterEach, describe, expect, test} from 'bun:test';
import {cleanup, fireEvent, render, screen, waitFor} from '@testing-library/react';
import {createMemoryRouter, RouterProvider} from 'react-router';
import {TooltipProvider} from '@proxy/ui/components/tooltip';
import {ThemeProvider} from '@proxy/ui/components/theme-provider';
import {HumanSide} from '@/components/human-side';
import {VaultPage} from '@/pages/vault-page';
import {testHuman, testOrg} from '@/test-org';

afterEach(() => {
	cleanup();
});

type Entry = {id: string; values: Record<string, string>};

// A vault the person uses with its entries: their own, built in, or, named, one a member made,
// theirs unless `owner` says whose, shared with whoever `with_` says.
function vault(
	id: string,
	entries: Entry[],
	made: {
		name: string;
		owner?: {userId: string; name: string};
		sharedWith?: Connection['sharedWith'];
	} | null = null,
) {
	const sharedWith = made?.sharedWith ?? [];
	const connection: Connection = {
		id,
		orgId: 'org-1',
		integrationId: 'vault',
		account: 'Acme',
		ownerUserId: made?.owner?.userId ?? 'user-1',
		owner: made?.owner?.name ?? 'Alex',
		sharedWithEveryone: false,
		sharedWith,
		shared: sharedWith.length > 0,
		builtIn: made === null,
		defaults: ['readEntries', 'writeEntries'],
		tools: null,
		name: made?.name ?? null,
		unavailable: [],
		signInNeeded: false,
	};
	return {
		connection,
		entries: entries.map((entry): DataRecord => ({
			...entry,
			updatedAt: '2026-10-21T00:00:00.000Z',
		})),
	};
}

// The page of one vault, as its loader answers it: the person's own with the entries unless
// `shown` is another, at that vault's address.
function renderVaultPage(
	entries: Entry[],
	shown: ReturnType<typeof vault> = vault('vault-1', entries),
) {
	const {connection} = shown;
	const router = createMemoryRouter(
		[
			{
				id: 'human',
				loader: () => testHuman(testOrg),
				element: <HumanSide />,
				children: ['/:org/connections/vault', '/:org/connections/vault/:id'].map((path) => ({
					path,
					loader: () => ({vault: connection, entries: shown.entries}),
					element: <VaultPage />,
				})),
			},
		],
		{
			initialEntries: [
				connection.builtIn ? '/acme/connections/vault' : `/acme/connections/vault/${connection.id}`,
			],
		},
	);

	return render(
		<ThemeProvider>
			<TooltipProvider>
				<RouterProvider router={router} />
			</TooltipProvider>
		</ThemeProvider>,
	);
}

const HOME: Entry = {id: 'entry-1', values: {title: 'Home', type: 'Address', content: '1 Main St'}};
const OFFICE: Entry = {
	id: 'entry-2',
	values: {title: 'Office', type: 'Address', content: '2 Side St'},
};

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

	test('the person’s own vault says what it is for while it is empty, and is the only vault on its page', async () => {
		renderVaultPage([]);

		expect(await screen.findByText(/what your agents should know about you/)).toBeDefined();
		expect(screen.getByText('My vault').parentElement?.textContent).toBe('My vaultVault');
		expect(screen.queryByText('Sharing and permissions')).toBeNull();
		expect(screen.queryByRole('button', {name: /Just me/})).toBeNull();
	});

	test('a vault a member made has a page of its own, by its name, with its entries alone', async () => {
		renderVaultPage([HOME], vault('vault-2', [OFFICE], {name: 'Finance'}));

		expect(await screen.findByRole('button', {name: /Office/})).toBeDefined();
		expect(screen.queryByRole('button', {name: /Home/})).toBeNull();
		expect(screen.getByText('Finance').parentElement?.textContent).toBe('FinanceVault');
	});

	test('a vault a member made says whose it is and who it is shared with, and links to where that is set', async () => {
		renderVaultPage(
			[],
			vault('vault-2', [], {name: 'Finance', sharedWith: [{userId: 'user-2', name: 'Dana'}]}),
		);

		expect((await screen.findByText(/Yours · shared with Dana/)).textContent).toContain(
			'Sharing and permissions',
		);
		expect(screen.getByRole('link', {name: 'Sharing and permissions'}).getAttribute('href')).toBe(
			'/acme/connections/vault-2',
		);
		expect(screen.getByText(/everyone who uses this vault should know/)).toBeDefined();
		cleanup();

		renderVaultPage(
			[],
			vault('vault-3', [], {
				name: 'Hiring',
				owner: {userId: 'user-2', name: 'Dana'},
				sharedWith: [{userId: 'user-1', name: 'Alex'}],
			}),
		);
		expect(await screen.findByText(/Dana’s · shared with Alex/)).toBeDefined();
	});

	test('a vault that isn’t the person’s to use is not found', async () => {
		const router = createMemoryRouter(
			[
				{
					id: 'human',
					loader: () => testHuman(testOrg),
					element: <HumanSide />,
					children: [
						{
							path: '/:org/connections/vault/:id',
							loader: () => ({vault: null, entries: []}),
							element: <VaultPage />,
						},
					],
				},
			],
			{initialEntries: ['/acme/connections/vault/someone-elses']},
		);
		render(
			<ThemeProvider>
				<TooltipProvider>
					<RouterProvider router={router} />
				</TooltipProvider>
			</ThemeProvider>,
		);

		expect(await screen.findByText('This vault does not exist anymore.')).toBeDefined();
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
