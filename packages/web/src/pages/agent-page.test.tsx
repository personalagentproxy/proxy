/// <reference types="bun" />

import type {AgentLogin, McpClient} from '@proxy/contracts/agents';
import type {Connection} from '@proxy/contracts/connections';
import type {Member} from '@proxy/contracts/orgs';
import {afterEach, describe, expect, test} from 'bun:test';
import {cleanup, fireEvent, render, screen, within} from '@testing-library/react';
import {createMemoryRouter, RouterProvider} from 'react-router';
import {ThemeProvider} from '@proxy/ui/components/theme-provider';
import {TooltipProvider} from '@proxy/ui/components/tooltip';
import {HumanSide} from '@/components/human-side';
import {shouldRevalidateTabs} from '@/lib/page-tabs';
import {AgentPage} from '@/pages/agent-page';
import {testHuman, testOrg} from '@/test-org';

afterEach(() => {
	cleanup();
});

// A mailbox of the person signed in, which agents read by default.
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

const alex: Member = {
	userId: 'user-1',
	name: 'Alex',
	email: 'alex@example.com',
	image: null,
	role: 'owner',
	joinedAt: '2026-10-01T00:00:00.000Z',
};

// Claude, the person's own, which may send from the mailbox though its default says no.
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
	grants: [{connectionId: 'conn-1', actionId: 'send', allowed: true}],
};

const desktop: McpClient = {
	id: 'client-1',
	name: 'Claude Desktop',
	connectedAt: '2026-10-02T00:00:00.000Z',
	connectedBy: 'Alex',
	mine: true,
};

// The agent's page at `entry`, loaded once: a second load would show the loader ran again.
function renderAgentPage(entry: string, mcpClients: McpClient[] = []) {
	const loads = {count: 0};
	const router = createMemoryRouter(
		[
			{
				id: 'human',
				loader: () => testHuman({...testOrg, memberCount: 2}),
				element: <HumanSide />,
				children: [
					{
						path: '/:org/agents/:id',
						loader: () => {
							loads.count += 1;
							return {
								agent: claude,
								connections: [mailbox],
								agents: [claude],
								entries: [],
								tasks: [],
								mcpClients,
								members: [alex],
							};
						},
						shouldRevalidate: shouldRevalidateTabs,
						element: <AgentPage />,
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
const nav = () => within(screen.getByRole('navigation', {name: 'Agent sections'}));
const tabs = () =>
	nav()
		.getAllByRole('button')
		.map((one) => one.textContent);

describe('AgentPage', () => {
	test('its parts are tabs, as a connection’s are, opening on Permissions, with the MCP clients only where there are any', async () => {
		renderAgentPage('/acme/agents/agent-1');
		expect(
			await screen.findByText(/Claude gets what each connection’s Default says/),
		).toBeDefined();
		expect(screen.getByText(/It has 1 of its own/)).toBeDefined();
		expect(tabs()).toEqual(['Permissions', 'Sharing', 'Recent activity']);
		cleanup();

		renderAgentPage('/acme/agents/agent-1', [desktop]);
		await screen.findByText(/Claude gets what each connection’s Default says/);
		expect(tabs()).toEqual(['Permissions', 'Sharing', 'MCP clients1', 'Recent activity']);
	});

	test('a connection’s name opens to a grid under it, of its default beside the agent’s own setting', async () => {
		renderAgentPage('/acme/agents/agent-1');

		const heading = await screen.findByRole('button', {name: /Email/});
		expect(heading.textContent).toBe('Email');
		fireEvent.click(heading);

		// The connection's name heads the grid, the columns' names at its end: no heading row beside it.
		expect(heading.textContent).toBe('EmailDefaultClaude');
		expect(screen.queryByRole('columnheader')).toBeNull();
		expect(screen.queryByText('Action')).toBeNull();
		expect(screen.queryByText('Changed')).toBeNull();
		expect(
			screen.getByRole('checkbox', {name: 'Send by default'}).getAttribute('aria-checked'),
		).toBe('false');
		expect(
			screen
				.getByRole('checkbox', {name: 'Send for Claude, its own setting'})
				.getAttribute('aria-checked'),
		).toBe('true');
		expect(
			screen.getByRole('checkbox', {name: 'Read for Claude'}).getAttribute('aria-checked'),
		).toBe('true');
		// Its own page is where its column would lead.
		expect(within(screen.getByRole('table')).queryByRole('link')).toBeNull();
	});

	test('a tab shows its part alone, without loading the page again', async () => {
		const loads = renderAgentPage('/acme/agents/agent-1', [desktop]);
		await screen.findByText(/Claude gets what each connection’s Default says/);

		fireEvent.click(nav().getByRole('button', {name: 'Sharing'}));
		expect(await screen.findByText('People with access')).toBeDefined();
		expect(screen.getByText(/Only you see Claude/)).toBeDefined();
		expect(screen.getByRole('button', {name: 'Share with everyone'})).toBeDefined();
		expect(screen.queryByRole('searchbox')).toBeNull();

		fireEvent.click(nav().getByRole('button', {name: /MCP clients/}));
		expect(await screen.findByText('Claude Desktop')).toBeDefined();

		fireEvent.click(nav().getByRole('button', {name: 'Recent activity'}));
		expect(await screen.findByRole('button', {name: 'Refresh activity'})).toBeDefined();
		expect(screen.queryByText('Claude Desktop')).toBeNull();
		expect(loads.count).toBe(1);
	});
});
