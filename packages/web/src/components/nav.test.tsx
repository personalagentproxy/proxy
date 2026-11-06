/// <reference types="bun" />

import {afterEach, describe, expect, test} from 'bun:test';
import {cleanup, fireEvent, render, screen, within} from '@testing-library/react';
import {createMemoryRouter, RouterProvider} from 'react-router';
import {SidebarProvider} from '@proxy/ui/components/sidebar';
import {ThemeProvider} from '@proxy/ui/components/theme-provider';
import {TooltipProvider} from '@proxy/ui/components/tooltip';
import {AppSidebar} from '@/components/nav';
import {type Unread, UnreadContext} from '@/hooks/use-unread';
import type {Human} from '@/lib/orgs';
import {testHuman, testOrg} from '@/test-org';

afterEach(() => {
	cleanup();
});

// What is unread, as the provider around the human side would have it.
function unreadOf(ids: string[]): Unread {
	return {
		unreadIds: new Set(ids),
		answers: null,
		setViewing: () => undefined,
	};
}

function renderSidebar(human: Human, entry = '/acme', unread = unreadOf([])) {
	const router = createMemoryRouter(
		[
			{
				id: 'human',
				path: '/:org/*',
				loader: () => human,
				element: <AppSidebar />,
			},
		],
		{initialEntries: [entry]},
	);

	return render(
		<ThemeProvider>
			<TooltipProvider>
				<SidebarProvider collapsed>
					<UnreadContext.Provider value={unread}>
						<RouterProvider router={router} />
					</UnreadContext.Provider>
				</SidebarProvider>
			</TooltipProvider>
		</ThemeProvider>,
	);
}

// The organization's pages in the sidebar, group by group.
function groupLabels(): string[][] {
	return [...document.querySelectorAll('[data-sidebar="content"] [data-sidebar="group"]')].map(
		(group) =>
			within(group as HTMLElement)
				.getAllByRole('link')
				.map((link) => link.textContent),
	);
}

describe('AppSidebar', () => {
	test("groups the organization's pages, its members and settings in the switcher", async () => {
		renderSidebar(testHuman());
		const home = await screen.findByRole('link', {name: 'Home'});
		expect(home.hasAttribute('data-active')).toBe(true);
		expect(
			screen.getByRole('button', {name: 'Organization: Acme'}).hasAttribute('data-active'),
		).toBe(false);

		expect(groupLabels()).toEqual([['Home'], ['Connections', 'Agent permissions'], ['Activity']]);

		fireEvent.click(screen.getByRole('button', {name: 'Organization: Acme'}));
		const members = await screen.findByRole('menuitem', {name: 'Members'});
		expect(members.getAttribute('href')).toBe('/acme/members');
		const settings = screen.getByRole('menuitem', {name: 'Settings'});
		expect(settings.getAttribute('href')).toBe('/acme/settings');
	});

	test('shows Chat beside Home, and Alerts under Activity, with the harness experiment', async () => {
		renderSidebar(testHuman({...testOrg, experiments: ['harness']}));
		await screen.findByRole('link', {name: 'Home'});

		expect(groupLabels()).toEqual([
			['Home', 'Chat'],
			['Connections', 'Agent permissions'],
			['Activity', 'Alerts'],
		]);
	});

	test('counts the conversations with something unread on Chat', async () => {
		renderSidebar(
			testHuman({...testOrg, experiments: ['harness']}),
			'/acme',
			unreadOf(['general', 'finance']),
		);
		await screen.findByRole('link', {name: 'Chat'});

		const badge = screen.getByRole('status', {name: '2 unread'});
		expect(badge.textContent).toBe('2');
		expect(badge.closest('li')?.querySelector('a')?.textContent).toBe('Chat');
	});

	test("lights the switcher on the organization's members and settings", async () => {
		renderSidebar(testHuman(), '/acme/members');

		const switcher = await screen.findByRole('button', {name: 'Organization: Acme'});
		expect(switcher.hasAttribute('data-active')).toBe(true);
		expect(screen.getByRole('link', {name: 'Home'}).hasAttribute('data-active')).toBe(false);
	});

	test('links the signed-in Google profile image to Account', async () => {
		const human = testHuman();
		human.user = {
			...human.user,
			name: 'Ada Lovelace',
			image: 'https://example.com/ada.png',
		};
		renderSidebar(human);

		const account = await screen.findByRole('link', {name: 'Account'});
		const avatar = account.querySelector('[data-slot="person-avatar"]');
		const image = account.querySelector('img');
		expect(account.getAttribute('href')).toBe('/account');
		expect(avatar?.parentElement?.classList).toContain('size-4');
		expect(avatar?.classList).toContain('size-6');
		expect(image?.getAttribute('src')).toBe('https://example.com/ada.png');
	});
});
