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

function connection(id: string, integrationId: string, shared: boolean): Connection {
	return {
		id,
		orgId: 'org-1',
		integrationId,
		account: 'Acme',
		shared,
		connectedById: 'user-1',
		connectedBy: null,
		defaults: [],
		tools: null,
		name: null,
		unavailable: [],
		signInNeeded: false,
	};
}

// The organization's two vaults and a shared Google account; alone in it unless `org` says
// otherwise.
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
								connection('vault-own', 'vault', false),
								connection('vault-shared', 'vault', true),
								connection('google-1', 'google', true),
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

describe('ConnectionsPage', () => {
	test('alone in the organization, lists the vault once, first, opening both', async () => {
		renderConnectionsPage('/acme/connections');

		const [first] = await screen.findAllByRole('link', {name: /Vault|Google/});
		expect(first?.textContent).toContain('Vault');
		expect(first?.getAttribute('href')).toBe('/acme/connections/vault');
		expect(screen.getAllByRole('link', {name: /Vault/})).toHaveLength(1);
	});

	test('with others in the organization, opens the vault of the side shown', async () => {
		const shared = {...testOrg, memberCount: 2};
		renderConnectionsPage('/acme/connections', shared);
		const everyone = await screen.findByRole('link', {name: /Vault/});
		expect(everyone.getAttribute('href')).toBe('/acme/connections/vault?for=everyone');
		cleanup();

		renderConnectionsPage('/acme/connections?for=me', shared);
		const own = await screen.findByRole('link', {name: /Vault/});
		expect(own.getAttribute('href')).toBe('/acme/connections/vault?for=me');
	});
});
