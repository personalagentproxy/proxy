/// <reference types="bun" />

import type {AgentLogin} from '@proxy/contracts/agents';
import type {Org} from '@proxy/contracts/orgs';
import {afterEach, describe, expect, test} from 'bun:test';
import {cleanup, fireEvent, render, screen, within} from '@testing-library/react';
import {createMemoryRouter, RouterProvider} from 'react-router';
import {ThemeProvider} from '@proxy/ui/components/theme-provider';
import {TooltipProvider} from '@proxy/ui/components/tooltip';
import {HumanSide} from '@/components/human-side';
import {AgentsPage} from '@/pages/agents-page';
import {later} from '@/lib/loader-utils';
import {testHuman, testOrg} from '@/test-org';

afterEach(() => {
	cleanup();
});

// An agent login, Alex's own (the person signed in) unless `with_` says otherwise.
function agent(
	id: string,
	name: string,
	with_: Partial<Pick<AgentLogin, 'providerId' | 'shared' | 'createdById' | 'revokedAt'>> = {},
): AgentLogin {
	return {
		id,
		providerId: with_.providerId ?? 'claude-code',
		name,
		username: `${id}@agents.test`,
		shared: with_.shared ?? false,
		createdById: with_.createdById === undefined ? 'user-1' : with_.createdById,
		createdBy: 'Alex',
		createdAt: '2026-01-01T00:00:00.000Z',
		lastActiveAt: null,
		revokedAt: with_.revokedAt ?? null,
		grants: [],
	};
}

// A member, not the owner, of an organization with others in it.
const crowded: Org = {...testOrg, role: 'member', memberCount: 3};

// The built-in agent, one shared by Alex and one by Dana, and two of Alex's own, one revoked.
function renderAgentsPage(entry: string, org: Org = crowded) {
	const router = createMemoryRouter(
		[
			{
				id: 'human',
				loader: () => testHuman(org),
				element: <HumanSide />,
				children: [
					{
						path: '/:org/agents',
						loader: later(async () => ({
							agents: [
								agent('proxy-1', 'Personal Agent Proxy', {
									providerId: 'proxy',
									shared: true,
									createdById: null,
								}),
								agent('team-alex', 'Team helper', {shared: true}),
								agent('team-dana', 'Dana’s helper', {shared: true, createdById: 'user-2'}),
								agent('own-1', 'Laptop'),
								agent('own-2', 'Old laptop', {revokedAt: '2026-02-01T00:00:00.000Z'}),
							],
						})),
						element: <AgentsPage />,
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

async function menuOf(name: RegExp): Promise<string[]> {
	fireEvent.contextMenu(await screen.findByRole('link', {name}));
	const menu = await screen.findByRole('menu');
	const items = within(menu)
		.getAllByRole('menuitem')
		.map((item) => item.textContent ?? '');
	fireEvent.keyDown(menu, {key: 'Escape'});
	return items;
}

describe('AgentsPage', () => {
	test('a right click on an agent of the person’s own renames it, sets it up again, revokes or restores its login, or deletes it', async () => {
		renderAgentsPage('/acme/agents?for=me');

		expect(await menuOf(/^Laptop/)).toEqual(['Rename', 'Set up again', 'Revoke login', 'Delete']);
		expect(await menuOf(/^Old laptop/)).toEqual(['Rename', 'Restore login', 'Delete']);
	});

	test('a shared agent has the menu only for whoever made it, or the organization’s owner', async () => {
		renderAgentsPage('/acme/agents?for=everyone');

		expect(await menuOf(/^Team helper/)).toEqual([
			'Rename',
			'Set up again',
			'Revoke login',
			'Delete',
		]);
		for (const name of [/^Dana’s helper/, /^Personal Agent Proxy/]) {
			fireEvent.contextMenu(await screen.findByRole('link', {name}));
			await new Promise((resolve) => setTimeout(resolve, 50));
			expect(screen.queryByRole('menu')).toBeNull();
		}
	});

	test('for the organization’s owner, every shared agent has the menu, the built-in one only renaming it', async () => {
		renderAgentsPage('/acme/agents?for=everyone', {...crowded, role: 'owner'});

		expect(await menuOf(/^Dana’s helper/)).toEqual([
			'Rename',
			'Set up again',
			'Revoke login',
			'Delete',
		]);
		expect(await menuOf(/^Personal Agent Proxy/)).toEqual(['Rename']);
	});

	test('Rename opens a dialog with the agent’s name', async () => {
		renderAgentsPage('/acme/agents?for=me');

		fireEvent.contextMenu(await screen.findByRole('link', {name: /^Laptop/}));
		fireEvent.click(await screen.findByRole('menuitem', {name: 'Rename'}));
		const dialog = await screen.findByRole('dialog');
		expect(within(dialog).getByText('Rename Laptop')).toBeTruthy();
		expect((within(dialog).getByRole('textbox') as HTMLInputElement).value).toBe('Laptop');
	});
});
