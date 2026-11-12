/// <reference types="bun" />

import type {Connection} from '@proxy/contracts/connections';
import type {Member, Org} from '@proxy/contracts/orgs';
import {afterEach, describe, expect, test} from 'bun:test';
import {cleanup, fireEvent, render, screen, waitFor} from '@testing-library/react';
import {createMemoryRouter, RouterProvider} from 'react-router';
import {ThemeProvider} from '@proxy/ui/components/theme-provider';
import {TooltipProvider} from '@proxy/ui/components/tooltip';
import {HumanSide} from '@/components/human-side';
import {ConnectionsPage} from '@/pages/connections-page';
import {later} from '@/lib/loader-utils';
import {testHuman, testOrg} from '@/test-org';

afterEach(() => {
	cleanup();
});

// A connection of Alex's, the person signed in: their built-in vault, or one they connected or
// made, theirs alone unless `with_` says who else has it.
function connection(
	id: string,
	integrationId: string,
	with_: Partial<Pick<Connection, 'sharedWithEveryone' | 'sharedWith' | 'name' | 'builtIn'>> = {},
): Connection {
	const sharedWithEveryone = with_.sharedWithEveryone ?? false;
	const sharedWith = with_.sharedWith ?? [];
	return {
		id,
		orgId: 'org-1',
		integrationId,
		account: 'Acme',
		ownerUserId: 'user-1',
		owner: 'Alex',
		sharedWithEveryone,
		sharedWith,
		shared: sharedWithEveryone || sharedWith.length > 0,
		builtIn: with_.builtIn ?? false,
		defaults: [],
		tools: null,
		name: with_.name ?? null,
		unavailable: [],
		signInNeeded: false,
	};
}

function member(userId: string, name: string): Member {
	return {
		userId,
		name,
		email: `${name.toLowerCase()}@acme.test`,
		image: null,
		role: 'member',
		joinedAt: '2026-01-01T00:00:00.000Z',
	};
}

// The person's own vault, a vault they made for Dana, a Google account every member has and a
// mailbox of their own; alone in the organization unless `org` says otherwise.
function renderConnectionsPage(entry: string, org: Org = testOrg) {
	const router = createMemoryRouter(
		[
			{
				id: 'human',
				loader: () => testHuman(org),
				element: <HumanSide />,
				children: [
					{
						path: '/:org/connections',
						loader: later(async () => ({
							connections: [
								connection('vault-own', 'vault', {builtIn: true}),
								connection('vault-made', 'vault', {
									name: 'Finance',
									sharedWith: [{userId: 'user-2', name: 'Dana'}],
								}),
								connection('google-1', 'google', {sharedWithEveryone: true}),
								connection('email-1', 'email'),
							],
							agents: [],
							members: [
								member('user-1', 'Alex'),
								member('user-2', 'Dana'),
								member('user-3', 'Sam'),
							],
						})),
						element: <ConnectionsPage />,
					},
				],
			},
		],
		{initialEntries: [entry]},
	);

	return render(
		<ThemeProvider>
			<TooltipProvider>
				<RouterProvider router={router} />
			</TooltipProvider>
		</ThemeProvider>,
	);
}

const ROWS = /My vault|Finance|Google|Email/;

function rows(): Array<[string, string | null]> {
	return screen
		.getAllByRole('link', {name: ROWS})
		.filter((row) => !row.getAttribute('href')?.includes('?tab=sharing'))
		.map((row) => [row.textContent?.match(ROWS)?.[0] ?? '', row.getAttribute('href')]);
}

describe('ConnectionsPage', () => {
	test('lists every connection by service name with person access filters and sharing details', async () => {
		renderConnectionsPage('/acme/connections');
		await screen.findAllByRole('link', {name: ROWS});

		expect(rows()).toEqual([
			['Email', '/acme/connections/email-1'],
			['Finance', '/acme/connections/vault-made'],
			['Google', '/acme/connections/google-1'],
			['My vault', '/acme/connections/vault-own'],
		]);
		expect(screen.getByText('4 shown')).toBeTruthy();
		expect(screen.queryByRole('combobox', {name: /access/i})).toBeNull();
		expect(screen.getByRole('button', {name: 'All people'})).toBeTruthy();
		expect(screen.getByRole('button', {name: 'Dana'})).toBeTruthy();
	});

	test('filters by clicking a person and restores all connections from the all-people button', async () => {
		const withOthers = {...testOrg, memberCount: 2};
		renderConnectionsPage('/acme/connections', withOthers);
		await screen.findAllByRole('link', {name: ROWS});
		fireEvent.click(screen.getByRole('button', {name: 'Dana'}));
		await waitFor(() => {
			expect(rows()).toEqual([
				['Finance', '/acme/connections/vault-made'],
				['Google', '/acme/connections/google-1'],
			]);
		});
		fireEvent.click(screen.getByRole('button', {name: 'All people'}));
		await waitFor(() => expect(rows()).toHaveLength(4));
	});

	test('sorts by clicking the Service heading', async () => {
		renderConnectionsPage('/acme/connections');
		await screen.findAllByRole('link', {name: ROWS});
		fireEvent.click(screen.getByRole('button', {name: 'Service ↑'}));
		expect(rows()[0]?.[0]).toBe('My vault');
	});
});
