/// <reference types="bun" />

import type {AgentLogin} from '@proxy/contracts/agents';
import type {Connection} from '@proxy/contracts/connections';
import type {Member} from '@proxy/contracts/orgs';
import {afterEach, describe, expect, test} from 'bun:test';
import {cleanup, fireEvent, render, screen, within} from '@testing-library/react';
import {createMemoryRouter, RouterProvider} from 'react-router';
import {ThemeProvider} from '@proxy/ui/components/theme-provider';
import {TooltipProvider} from '@proxy/ui/components/tooltip';
import {HumanSide} from '@/components/human-side';
import {shouldRevalidateTabs} from '@/lib/page-tabs';
import {ConnectionPage} from '@/pages/connection-page';
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
						loader: () => {
							loads.count += 1;
							return {
								connection,
								connections: [connection],
								agents,
								entries: [],
								tasks: [],
								members: [dana],
							};
						},
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

		expect(await screen.findByRole('checkbox', {name: /Read/})).toBeDefined();
		expect(tabs()).toEqual([
			['Permissions', 'page'],
			['Sharing', null],
			['Agents1', null],
			['Recent activity', null],
		]);
		expect(screen.queryByText('People with access')).toBeNull();
		expect(screen.queryByText('Claude')).toBeNull();
	});

	test('a tab shows its part alone, at an address of its own, without loading the page again', async () => {
		const loads = renderConnectionPage('/acme/connections/conn-1');
		await screen.findByRole('checkbox', {name: /Read/});

		fireEvent.click(tab('Sharing'));
		expect(await screen.findByText('People with access')).toBeDefined();
		expect(screen.getByRole('button', {name: 'Add people'})).toBeDefined();
		expect(screen.queryByRole('checkbox', {name: /Read/})).toBeNull();
		expect(tab('Sharing').getAttribute('href')).toBe('/acme/connections/conn-1?tab=sharing');

		fireEvent.click(tab(/Agents/));
		expect(await screen.findByText('Claude')).toBeDefined();
		expect(screen.queryByText('People with access')).toBeNull();

		fireEvent.click(tab('Recent activity'));
		expect(await screen.findByRole('button', {name: 'Refresh activity'})).toBeDefined();
		expect(screen.queryByText('Claude')).toBeNull();
		expect(loads.count).toBe(1);
	});

	test('Permissions says whose defaults these are, and which agents have a setting of their own, each a link to it', async () => {
		renderConnectionPage('/acme/connections/conn-1', mailbox, [
			{...claude, grants: [{connectionId: 'conn-1', actionId: 'send', allowed: true}]},
		]);

		expect(await screen.findByText(/What your agents may do with it by default/)).toBeDefined();
		expect(screen.getByText('1 of 7 on')).toBeDefined();
		const differs = screen.getByRole('link', {name: 'Claude has its own setting'});
		expect(differs.getAttribute('href')).toBe('/acme/agents/agent-1');
		expect(differs.closest('li')?.textContent).toContain('Send');
	});

	test('the address opens the page on the tab it names', async () => {
		renderConnectionPage('/acme/connections/conn-1?tab=sharing');

		expect(await screen.findByText('People with access')).toBeDefined();
		expect(tabs().find(([, current]) => current === 'page')?.[0]).toBe('Sharing');
	});

	test('a built-in connection, which is never shared, has no Sharing tab', async () => {
		renderConnectionPage('/acme/connections/conn-1?tab=sharing', {
			...mailbox,
			integrationId: 'vault',
			defaults: ['readEntries'],
			builtIn: true,
		});

		expect(await screen.findByRole('checkbox', {name: /Read entries/})).toBeDefined();
		expect(tabs().map(([label]) => label)).toEqual(['Permissions', 'Agents1', 'Recent activity']);
	});
});
