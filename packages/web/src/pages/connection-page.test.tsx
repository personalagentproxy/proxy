/// <reference types="bun" />

import type {AgentLogin} from '@proxy/contracts/agents';
import type {Connection} from '@proxy/contracts/connections';
import type {Member} from '@proxy/contracts/orgs';
import type {DataRecord} from '@proxy/contracts/records';
import {DEFAULT_LOOK} from '@proxy/utils/harness';
import type {GitHubReach} from '@/lib/github';
import {afterEach, describe, expect, test, spyOn} from 'bun:test';
import {cleanup, fireEvent, render, screen, waitFor, within} from '@testing-library/react';
import {createMemoryRouter, RouterProvider} from 'react-router';
import {ThemeProvider} from '@proxy/ui/components/theme-provider';
import {TooltipProvider} from '@proxy/ui/components/tooltip';
import {HumanSide} from '@/components/human-side';
import type {LoadedBy} from '@/hooks/use-loaded';
import {shouldRevalidateTabs} from '@/lib/page-tabs';
import {ConnectionPage} from '@/pages/connection-page';
import {later} from '@/lib/loader-utils';
import type {connectionLoader} from '@/loaders';
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

// A drive as its page's loader gives it: where the person is in it, what is listed there, and the
// file shown over it.
type Drive = NonNullable<LoadedBy<typeof connectionLoader>['files']>;

// The connection's page at `entry`, loading `connection` once: a second load would show the
// loader ran again.
function renderConnectionPage(
	entry: string,
	connection: Connection = mailbox,
	agents: AgentLogin[] = [claude],
	vaultEntries: DataRecord[] | null = null,
	sandboxes: DataRecord[] | null = null,
	github: GitHubReach | null = null,
	files: Drive | null = null,
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
								files,
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

	test('every integration’s grid has an All row, not only a custom MCP server’s', async () => {
		renderConnectionPage('/acme/connections/conn-1');

		expect(
			(await screen.findByRole('checkbox', {name: 'All by default'})).getAttribute('aria-checked'),
		).toBe('mixed');
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

	test('Chat, which the Chat page’s personas act through, has a column on every connection, changed by whoever changes its defaults', async () => {
		const chat: AgentLogin = {
			...claude,
			id: 'agent-chat',
			providerId: 'proxy',
			name: 'Chat',
			shared: true,
			createdById: null,
			createdBy: null,
		};
		renderConnectionPage('/acme/connections/conn-1', mailbox, [claude, chat]);

		expect(await screen.findByRole('checkbox', {name: 'Send for Chat'})).toBeDefined();
		expect(screen.getAllByRole('columnheader').map((heading) => heading.textContent)).toEqual([
			'Action',
			'Default',
			'Claude',
			'Chat',
		]);
		expect(
			screen.getByRole('checkbox', {name: 'Send for Chat'}).hasAttribute('data-disabled'),
		).toBe(false);
		cleanup();

		// Dana's mailbox, shared with the person by name: Dana's to change, Chat's settings there too.
		const danas: Connection = {
			...mailbox,
			ownerUserId: 'user-2',
			owner: 'Dana',
			sharedWith: [{userId: 'user-1', name: 'Alex'}],
			shared: true,
		};
		renderConnectionPage('/acme/connections/conn-1', danas, [chat]);

		expect(
			(await screen.findByRole('checkbox', {name: 'Send for Chat'})).hasAttribute('data-disabled'),
		).toBe(true);
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

	test('the person’s drive opens on its files, a folder a link into it and a file a link that shows it, and, never shared, has no Sharing tab', async () => {
		const file = {
			parentId: null,
			path: null,
			shown: false,
			modifiedAt: '2026-10-21T00:00:00.000Z',
			trashedAt: null,
			makers: [],
		};
		renderConnectionPage(
			'/acme/connections/conn-1',
			{...mailbox, integrationId: 'files', defaults: ['readFiles'], builtIn: true},
			[claude],
			null,
			null,
			null,
			{
				place: {folder: null, file: null, trash: false, search: null},
				list: {
					files: [
						{
							...file,
							id: 'folder-1',
							name: 'Reports',
							folder: true,
							version: null,
							type: null,
							size: null,
						},
						{
							...file,
							id: 'file-1',
							name: 'pricing.md',
							folder: false,
							version: 'v2',
							type: 'text/markdown',
							size: 2048,
							makers: [
								{
									kind: 'persona' as const,
									id: 'persona-1',
									name: 'General',
									look: DEFAULT_LOOK,
									color: 'blue' as const,
								},
								{kind: 'agent' as const, id: 'agent-1', name: 'Claude Code', providerId: 'claude'},
							],
						},
					],
					trail: [],
				},
				shown: null,
			},
		);

		expect((await screen.findByRole('link', {name: /Reports/})).getAttribute('href')).toBe(
			'/acme/connections/conn-1?folder=folder-1',
		);
		const row = screen.getByRole('link', {name: /pricing\.md/});
		expect(row.getAttribute('href')).toBe('/acme/connections/conn-1?file=file-1');
		expect(row.textContent).toContain('2 KB');
		// The agents that made it, by their heads, named for whoever can't see them.
		expect(within(row).getByLabelText('Made by General and Claude Code')).toBeTruthy();
		expect(
			within(screen.getByRole('link', {name: /Reports/})).queryByLabelText(/Made by/),
		).toBeNull();
		expect(tabs()).toEqual([
			['Files', 'page'],
			['Permissions', null],
			['Recent activity', null],
		]);
		expect(screen.getByRole('button', {name: 'Upload'})).toBeTruthy();
	});

	test('a file of a drive opens over its folder with its versions, each saved or given back, and who made it', async () => {
		const file = {
			id: 'file-1',
			name: 'pricing.md',
			folder: false,
			parentId: null,
			path: null,
			version: 'v2',
			type: 'text/markdown',
			size: 2048,
			shown: false,
			modifiedAt: '2026-10-21T00:00:00.000Z',
			trashedAt: null,
			makers: [],
		};
		const version = {
			size: 2048,
			type: 'text/markdown',
			at: '2026-10-21T00:00:00.000Z',
			restored: false,
		};
		renderConnectionPage(
			'/acme/connections/conn-1?file=file-1',
			{...mailbox, integrationId: 'files', defaults: ['readFiles'], builtIn: true},
			[claude],
			null,
			null,
			null,
			{
				place: {folder: null, file: 'file-1', trash: false, search: null},
				list: {files: [file], trail: []},
				shown: {
					file,
					trail: [],
					versions: [
						{
							...version,
							id: 'v2',
							current: true,
							name: 'pricing.md',
							by: {
								kind: 'persona' as const,
								id: 'persona-1',
								name: 'General',
								look: DEFAULT_LOOK,
								color: 'blue' as const,
								task: {id: 'task-1', title: 'Tidy the pricing notes'},
							},
						},
						{
							...version,
							id: 'v1',
							current: false,
							name: 'pricing draft.md',
							by: {kind: 'person' as const, name: 'Alex', email: 'alex@example.com', image: null},
						},
					],
				},
			},
		);

		const dialog = await screen.findByRole('dialog');
		expect(dialog.textContent).toContain('text/markdown · 2 KB');
		// A row a version: what the file was called then, its size, when, who made it, and whether it is held now.
		const rows = within(dialog).getAllByRole('listitem');
		expect(rows[0]?.textContent).toContain('pricing.md');
		expect(rows[0]?.textContent).toContain('GeneralTidy the pricing notes');
		expect(rows[0]?.textContent).toContain('Current');
		expect(rows[1]?.textContent).toContain('pricing draft.md');
		expect(rows[1]?.textContent).toContain('Alex');
		expect(rows[1]?.textContent).not.toContain('Current');
		expect(
			within(dialog).getByRole('link', {name: 'Tidy the pricing notes'}).getAttribute('href'),
		).toBe('/acme/activity/tasks/task-1');
		expect(
			within(dialog)
				.getAllByRole('button', {name: 'Download'})
				.map((link) => link.getAttribute('href')),
		).toEqual(['/api/orgs/acme/connections/conn-1/files/file-1/content']);
		expect(
			within(dialog)
				.getAllByRole('button', {name: 'Download this version'})
				.map((link) => link.getAttribute('href')),
		).toEqual([
			'/api/orgs/acme/connections/conn-1/files/file-1/content?version=v2',
			'/api/orgs/acme/connections/conn-1/files/file-1/content?version=v1',
		]);
		// The version it holds is marked; one before it can be given back.
		expect(within(dialog).getAllByRole('button', {name: 'Restore this version'})).toHaveLength(1);
		expect(within(dialog).getByText('Current')).toBeTruthy();
	});

	test('a search of a drive lists what its name is in, each with where it is, and keeps the search while a file is shown', async () => {
		const found = {
			folder: false,
			version: 'v1',
			type: 'text/markdown',
			size: 2048,
			shown: false,
			modifiedAt: '2026-10-21T00:00:00.000Z',
			trashedAt: null,
			makers: [],
		};
		renderConnectionPage(
			'/acme/connections/conn-1?folder=folder-1&q=pricing',
			{...mailbox, integrationId: 'files', defaults: ['readFiles'], builtIn: true},
			[claude],
			null,
			null,
			null,
			{
				place: {folder: 'folder-1', file: null, trash: false, search: 'pricing'},
				list: {
					files: [
						{...found, id: 'file-1', name: 'pricing.md', parentId: 'folder-1', path: 'Reports'},
						{
							...found,
							id: 'file-2',
							name: 'pricing-2026.md',
							parentId: 'folder-2',
							path: 'Reports / 2026',
						},
					],
					trail: [{id: 'folder-1', name: 'Reports'}],
				},
				shown: null,
			},
		);

		const deep = await screen.findByRole('link', {name: /pricing-2026\.md/});
		expect(deep.textContent).toContain('Reports / 2026');
		expect(deep.getAttribute('href')).toBe(
			'/acme/connections/conn-1?folder=folder-1&q=pricing&file=file-2',
		);
		expect((screen.getByLabelText('Search this folder') as HTMLInputElement).value).toBe('pricing');
	});

	test('a file or a folder is moved by opening the folder it goes into, from where it is now', async () => {
		const realFetch = globalThis.fetch;
		const calls: Array<[string, string, string | undefined]> = [];
		const folder = (id: string, name: string, parentId: string | null) => ({
			id,
			name,
			folder: true,
			parentId,
			path: null,
			version: null,
			type: null,
			size: null,
			shown: false,
			modifiedAt: '2026-10-21T00:00:00.000Z',
			trashedAt: null,
			makers: [],
		});
		const file = {...folder('file-1', 'pricing.md', null), folder: false, version: 'v1'};
		globalThis.fetch = ((input: string, init?: RequestInit) => {
			calls.push([
				init?.method ?? 'GET',
				input,
				typeof init?.body === 'string' ? init.body : undefined,
			]);
			if (init?.method === 'PATCH') {
				return Promise.resolve(Response.json({file: {...file, parentId: 'folder-1'}}));
			}
			return Promise.resolve(
				Response.json(
					input.includes('parent=folder-1')
						? {
								files: [folder('folder-2', '2026', 'folder-1')],
								trail: [{id: 'folder-1', name: 'Reports'}],
							}
						: {files: [folder('folder-1', 'Reports', null), file], trail: []},
				),
			);
		}) as typeof fetch;
		renderConnectionPage(
			'/acme/connections/conn-1',
			{...mailbox, integrationId: 'files', defaults: ['readFiles'], builtIn: true},
			[claude],
			null,
			null,
			null,
			{
				place: {folder: null, file: null, trash: false, search: null},
				list: {files: [folder('folder-1', 'Reports', null), file], trail: []},
				shown: null,
			},
		);

		fireEvent.contextMenu(await screen.findByRole('link', {name: /pricing\.md/}));
		fireEvent.click(await screen.findByRole('menuitem', {name: 'Move to…'}));
		const dialog = await screen.findByRole('dialog');
		// It opens where the file is, which is no place to move it to; only folders are offered.
		const move = within(dialog).getByRole('button', {name: 'Move here'}) as HTMLButtonElement;
		expect(move.disabled).toBe(true);
		fireEvent.click(await within(dialog).findByRole('button', {name: /Reports/}));
		expect(await within(dialog).findByRole('button', {name: /2026/})).toBeTruthy();
		expect(within(dialog).queryByText('pricing.md', {selector: 'li *'})).toBeNull();
		await waitFor(() => expect(move.disabled).toBe(false));

		fireEvent.click(move);

		await waitFor(() => expect(screen.queryByRole('dialog') === null).toBe(true));
		expect(calls.filter(([method]) => method === 'PATCH')).toEqual([
			[
				'PATCH',
				'/api/orgs/acme/connections/conn-1/files/file-1',
				JSON.stringify({parent: 'folder-1'}),
			],
		]);
		globalThis.fetch = realFetch;
	});

	test('a GitHub connection opens on its permissions, the repositories it reaches, by the account the app is installed on, a tab after', async () => {
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

		expect(await screen.findByRole('checkbox', {name: 'All by default'})).toBeDefined();
		expect(tabs()).toEqual([
			['Permissions', 'page'],
			['Repositories1', null],
			['Sharing', null],
			['Recent activity', null],
		]);
		expect(screen.queryByRole('button', {name: /acme\/api/})).toBeNull();

		fireEvent.click(tab(/Repositories/));
		expect(await screen.findByRole('button', {name: /acme\/api/})).toBeDefined();
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

test('a custom MCP server’s All row saves the defaults of only the tools the sign-in allows', async () => {
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
		fireEvent.click(await screen.findByRole('checkbox', {name: 'All by default'}));
		await waitFor(() => expect(fetch).toHaveBeenCalled());
		const writes = fetch.mock.calls.filter(
			([url, options]) => String(url).endsWith('/defaults') && options?.method === 'PUT',
		);
		expect(writes).toHaveLength(1);
		expect(JSON.parse(String(writes[0]?.[1]?.body))).toEqual({actions: {read: true, write: true}});
	} finally {
		fetch.mockRestore();
	}
});
