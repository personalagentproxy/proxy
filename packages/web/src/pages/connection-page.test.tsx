/// <reference types="bun" />

import type {AgentLogin} from '@proxy/contracts/agents';
import type {Connection} from '@proxy/contracts/connections';
import type {Member} from '@proxy/contracts/orgs';
import type {DataRecord} from '@proxy/contracts/records';
import type {GitHubReach} from '@/lib/github';
import {afterEach, describe, expect, test, spyOn} from 'bun:test';
import {cleanup, fireEvent, render, screen, waitFor, within} from '@testing-library/react';
import {createMemoryRouter, RouterProvider} from 'react-router';
import {ThemeProvider} from '@proxy/ui/components/theme-provider';
import {TooltipProvider} from '@proxy/ui/components/tooltip';
import {HumanSide} from '@/components/human-side';
import {shouldRevalidateTabs} from '@/lib/page-tabs';
import {ConnectionPage} from '@/pages/connection-page';
import {later} from '@/lib/loader-utils';
import {testHuman, testOrg} from '@/test-org';

afterEach(() => {
	cleanup();
});

// A mailbox of the person signed in, in an organization with Dana in it.
const mailbox: Connection = {
	id: 'conn-1',
	orgId: 'org-1',
	integrationId: 'email',
	account: 'alex@example.com',
	ownerUserId: 'user-1',
	owner: 'Alex',
	sharedWithEveryone: false,
	sharedWith: [],
	shared: false,
	builtIn: false,
	defaults: ['read'],
	tools: null,
	name: null,
	unavailable: [],
	signInNeeded: false,
};

const dana: Member = {
	userId: 'user-2',
	name: 'Dana',
	email: 'dana@example.com',
	image: null,
	role: 'member',
	joinedAt: '2026-10-01T00:00:00.000Z',
};

const claude: AgentLogin = {
	id: 'agent-1',
	providerId: 'claude',
	name: 'Claude',
	username: 'claude-1',
	shared: false,
	createdById: 'user-1',
	createdBy: 'Alex',
	createdAt: '2026-10-01T00:00:00.000Z',
	lastActiveAt: null,
	revokedAt: null,
	grants: [],
};

// The connection's page at `entry`, loading `connection` once: a second load would show the
// loader ran again.
function renderConnectionPage(
	entry: string,
	connection: Connection = mailbox,
	agents: AgentLogin[] = [claude],
	vaultEntries: DataRecord[] | null = null,
	sandboxes: DataRecord[] | null = null,
	github: GitHubReach | null = null,
) {
	const loads = {count: 0};
	const router = createMemoryRouter(
		[
			{
				id: 'human',
				loader: () => testHuman({...testOrg, memberCount: 2}),
				element: <HumanSide />,
				children: [
					{
						path: '/:org/connections/:id',
						loader: later(async () => {
							loads.count += 1;
							return {
								connection,
								connections: [connection],
								agents,
								entries: [],
								tasks: [],
								members: [dana],
								vaultEntries,
								sandboxes,
								github,
							};
						}),
						shouldRevalidate: shouldRevalidateTabs,
						element: <ConnectionPage />,
					},
				],
			},
		],
		{initialEntries: [entry]},
	);
	render(
		<ThemeProvider>
			<TooltipProvider>
				<RouterProvider router={router} />
			</TooltipProvider>
		</ThemeProvider>,
	);
	return loads;
}

// The page's tabs: links drawn as buttons, in their own navigation.
const nav = () => within(screen.getByRole('navigation', {name: 'Connection sections'}));
const tab = (name: string | RegExp) => nav().getByRole('button', {name});
const tabs = () =>
	nav()
		.getAllByRole('button')
		.map((one) => [one.textContent, one.getAttribute('aria-current')]);

describe('ConnectionPage', () => {
	test('its parts are tabs, one shown at a time, opening on Permissions', async () => {
		renderConnectionPage('/acme/connections/conn-1');

		expect(await screen.findByRole('checkbox', {name: 'Read by default'})).toBeDefined();
		expect(tabs()).toEqual([
			['Permissions', 'page'],
			['Sharing', null],
			['Recent activity', null],
		]);
		expect(screen.queryByText('People with access')).toBeNull();
		expect(screen.queryByRole('button', {name: 'Refresh activity'})).toBeNull();
	});

	test('a tab shows its part alone, at an address of its own, without loading the page again', async () => {
		const loads = renderConnectionPage('/acme/connections/conn-1');
		await screen.findByRole('checkbox', {name: 'Read by default'});

		fireEvent.click(tab('Sharing'));
		expect(await screen.findByText('People with access')).toBeDefined();
		expect(screen.getByRole('button', {name: 'Add people'})).toBeDefined();
		expect(screen.queryByRole('checkbox', {name: 'Read by default'})).toBeNull();
		expect(tab('Sharing').getAttribute('href')).toBe('/acme/connections/conn-1?tab=sharing');

		fireEvent.click(tab('Recent activity'));
		expect(await screen.findByRole('button', {name: 'Refresh activity'})).toBeDefined();
		expect(screen.queryByText('People with access')).toBeNull();
		expect(loads.count).toBe(1);
	});

	test('Permissions is a grid of the actions by the default and the agents that reach it, each agent a link', async () => {
		const shared: AgentLogin = {...claude, id: 'agent-2', name: 'Team', shared: true};
		const revoked: AgentLogin = {
			...claude,
			id: 'agent-3',
			name: 'Gone',
			revokedAt: '2026-10-02T00:00:00.000Z',
		};
		renderConnectionPage('/acme/connections/conn-1', mailbox, [
			{...claude, grants: [{connectionId: 'conn-1', actionId: 'send', allowed: true}]},
			shared,
			revoked,
		]);

		expect(await screen.findByText(/Your agents get what Default says/)).toBeDefined();
		// A shared agent doesn't reach a connection that isn't everyone's, and a revoked one reaches nothing.
		expect(screen.getAllByRole('columnheader').map((heading) => heading.textContent)).toEqual([
			'Action',
			'Default',
			'Claude',
		]);
		expect(screen.getByRole('link', {name: 'Claude'}).getAttribute('href')).toBe(
			'/acme/agents/agent-1',
		);
		expect(
			screen.getByRole('checkbox', {name: 'Read by default'}).getAttribute('aria-checked'),
		).toBe('true');
		expect(
			screen.getByRole('checkbox', {name: 'Read for Claude'}).getAttribute('aria-checked'),
		).toBe('true');
		expect(
			screen.getByRole('checkbox', {name: 'Send by default'}).getAttribute('aria-checked'),
		).toBe('false');
		expect(
			screen
				.getByRole('checkbox', {name: 'Send for Claude, its own setting'})
				.getAttribute('aria-checked'),
		).toBe('true');
	});

	test('the address opens the page on the tab it names', async () => {
		renderConnectionPage('/acme/connections/conn-1?tab=sharing');

		expect(await screen.findByText('People with access')).toBeDefined();
		expect(tabs().find(([, current]) => current === 'page')?.[0]).toBe('Sharing');
	});

	test('the person’s Sandboxes open on the sandboxes their agents made, and, never shared, have no Sharing tab', async () => {
		const sandbox: DataRecord = {
			id: 'sandbox-1',
			values: {
				name: 'site-build',
				state: 'Asleep',
				heldBy: '',
				lastUsedAt: '2026-10-21T00:00:00.000Z',
			},
			updatedAt: '2026-10-21T00:00:00.000Z',
		};
		renderConnectionPage(
			'/acme/connections/conn-1?tab=sharing',
			{...mailbox, integrationId: 'sandbox', defaults: ['read'], builtIn: true},
			[claude],
			null,
			[sandbox],
		);

		expect((await screen.findByRole('button', {name: /site-build/})).textContent).toContain(
			'Asleep',
		);
		expect(tabs()).toEqual([
			['Sandboxes1', 'page'],
			['Permissions', null],
			['Recent activity', null],
		]);

		fireEvent.click(tab('Permissions'));
		expect(await screen.findByRole('checkbox', {name: 'See sandboxes by default'})).toBeDefined();
		expect(screen.queryByRole('button', {name: /site-build/})).toBeNull();
	});

	test('a GitHub connection opens on the repositories it reaches, by the account the app is installed on', async () => {
		renderConnectionPage(
			'/acme/connections/conn-1',
			{...mailbox, integrationId: 'github', account: 'alexkim', defaults: ['read']},
			[claude],
			null,
			null,
			{
				installations: [
					{
						account: 'acme',
						accountType: 'Organization',
						all: true,
						settingsUrl: 'https://github.com/organizations/acme/settings/installations/11',
						repositories: [
							{
								fullName: 'acme/api',
								visibility: 'Public',
								pushedAt: null,
								url: 'https://github.com/acme/api',
							},
						],
						more: false,
					},
				],
				installUrl: 'https://github.com/apps/personal-agent-proxy/installations/new',
			},
		);

		expect(await screen.findByRole('button', {name: /acme\/api/})).toBeDefined();
		expect(tabs()).toEqual([
			['Repositories1', 'page'],
			['Permissions', null],
			['Sharing', null],
			['Recent activity', null],
		]);
		expect(screen.getByRole('link', {name: 'Add repositories'})).toBeDefined();
	});
});

describe('a vault’s page', () => {
	const ownVault: Connection = {
		...mailbox,
		integrationId: 'vault',
		account: 'Acme',
		defaults: ['readEntries'],
		builtIn: true,
	};
	const madeVault: Connection = {...ownVault, name: 'Finance', builtIn: false};
	const entry = (id: string, values: Record<string, string>): DataRecord => ({
		id,
		values,
		updatedAt: '2026-10-21T00:00:00.000Z',
	});
	const home = entry('entry-1', {
		title: 'Home',
		type: 'Address',
		content: '1 Main St\n10115 Berlin',
	});

	test('opens on its entries, the first of its tabs, each by its title, with its type and the first line of its content', async () => {
		renderConnectionPage('/acme/connections/conn-1', ownVault, [claude], [home]);

		const row = await screen.findByRole('button', {name: /Home/});
		expect(row.textContent).toContain('Address');
		expect(row.textContent).toContain('1 Main St');
		expect(row.textContent).not.toContain('Berlin');
		expect(tabs()).toEqual([
			['Entries1', 'page'],
			['Permissions', null],
			['Recent activity', null],
		]);
		expect(screen.getByText('What your agents should know about you')).toBeDefined();
	});

	test('a vault a member made has Sharing beside its entries, and says what it is for while it is empty', async () => {
		renderConnectionPage('/acme/connections/conn-1', madeVault, [claude], []);

		expect(
			await screen.findByText(/everyone who uses this vault should know, or let them keep/),
		).toBeDefined();
		expect(tabs().map(([label]) => label)).toEqual([
			'Entries0',
			'Permissions',
			'Sharing',
			'Recent activity',
		]);

		fireEvent.click(tab('Permissions'));
		expect(await screen.findByRole('checkbox', {name: 'Read entries by default'})).toBeDefined();
		expect(
			screen.queryByText(/everyone who uses this vault should know, or let them keep/),
		).toBeNull();
	});

	test('a new entry needs something written, its type alone is not enough', async () => {
		renderConnectionPage(
			'/acme/connections/conn-1',
			ownVault,
			[claude],
			[entry('entry-2', {title: 'Phone', type: 'Phone number', content: ''})],
		);

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

test('Enable all saves only available MCP defaults and Done leads to Connections', async () => {
	const connection: Connection = {
		...mailbox,
		integrationId: 'mcp',
		name: 'Example server',
		defaults: [],
		unavailable: ['blocked'],
		tools: [
			{name: 'read', inputSchema: {type: 'object'}},
			{name: 'write', inputSchema: {type: 'object'}},
			{name: 'blocked', inputSchema: {type: 'object'}},
		],
	};
	const fetch = spyOn(globalThis, 'fetch').mockResolvedValue(
		new Response(JSON.stringify(connection), {headers: {'content-type': 'application/json'}}),
	);
	try {
		renderConnectionPage('/acme/connections/conn-1', connection);
		fireEvent.click(await screen.findByRole('button', {name: 'Enable all'}));
		await waitFor(() => expect(fetch).toHaveBeenCalled());
		const writes = fetch.mock.calls.filter(
			([url, options]) => String(url).endsWith('/defaults') && options?.method === 'PUT',
		);
		expect(writes).toHaveLength(1);
		expect(JSON.parse(String(writes[0]?.[1]?.body))).toEqual({actions: {read: true, write: true}});
		expect(screen.getByRole('link', {name: 'Done'}).getAttribute('href')).toBe('/acme/connections');
	} finally {
		fetch.mockRestore();
	}
});
