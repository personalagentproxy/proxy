/// <reference types="bun" />

import type {Connection} from '@proxy/contracts/connections';
import type {Org} from '@proxy/contracts/orgs';
import {afterEach, describe, expect, test} from 'bun:test';
import {cleanup, render, screen} from '@testing-library/react';
import {createMemoryRouter, RouterProvider} from 'react-router';
import {ThemeProvider} from '@proxy/ui/components/theme-provider';
import {TooltipProvider} from '@proxy/ui/components/tooltip';
import {HumanSide} from '@/components/human-side';
import {ConnectionsPage} from '@/pages/connections-page';
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
						loader: () => ({
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
						}),
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
		.map((row) => [row.textContent?.match(ROWS)?.[0] ?? '', row.getAttribute('href')]);
}

describe('ConnectionsPage', () => {
	test('alone in the organization, lists everything, the person’s own vault first, and a vault they made as any connection, each opening its connection’s page', async () => {
		renderConnectionsPage('/acme/connections');
		await screen.findAllByRole('link', {name: ROWS});

		expect(rows()).toEqual([
			['My vault', '/acme/connections/vault-own'],
			['Finance', '/acme/connections/vault-made'],
			['Google', '/acme/connections/google-1'],
			['Email', '/acme/connections/email-1'],
		]);
	});

	test('with others in the organization, what is shared, with everyone or by name, is on one side, and what is the person’s alone, their own vault first, on the other, which the page opens on', async () => {
		const withOthers = {...testOrg, memberCount: 2};
		renderConnectionsPage('/acme/connections', withOthers);
		await screen.findAllByRole('link', {name: ROWS});
		expect(rows()).toEqual([
			['My vault', '/acme/connections/vault-own'],
			['Email', '/acme/connections/email-1'],
		]);
		expect(screen.getByRole('button', {name: /Shared/}).textContent).toContain('2');
		cleanup();

		renderConnectionsPage('/acme/connections?for=everyone', withOthers);
		await screen.findAllByRole('link', {name: ROWS});
		expect(rows()).toEqual([
			['Finance', '/acme/connections/vault-made'],
			['Google', '/acme/connections/google-1'],
		]);
	});
});
