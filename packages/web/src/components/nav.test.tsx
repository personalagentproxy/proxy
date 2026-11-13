/// <reference types="bun" />

import {afterEach, describe, expect, test} from 'bun:test';
import {act, cleanup, fireEvent, render, screen, within} from '@testing-library/react';
import {createMemoryRouter, RouterProvider, useLocation} from 'react-router';
import {SidebarProvider} from '@proxy/ui/components/sidebar';
import {ThemeProvider} from '@proxy/ui/components/theme-provider';
import {TooltipProvider} from '@proxy/ui/components/tooltip';
import {AppSidebar} from '@/components/nav';
import {InSidebar, SidebarPanelProvider} from '@/components/sidebar-panel';
import {useOrgSlug} from '@/hooks/use-org';
import {type Unread, UnreadContext} from '@/hooks/use-unread';
import type {Human} from '@/lib/orgs';
import {testHuman} from '@/test-org';

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

// The page beside the sidebar, started over in another organization as the human side's is: on
// Chat, its agents in the sidebar.
function Page() {
	const org = useOrgSlug();
	const {pathname} = useLocation();
	if (!pathname.startsWith(`/${org}/chat`)) {
		return null;
	}
	return (
		<InSidebar key={org} label="Chat">
			<p>Agents</p>
		</InSidebar>
	);
}

function renderSidebar(human: Human, entry = '/acme/connections', unread = unreadOf([])) {
	const router = createMemoryRouter(
		[
			{
				id: 'human',
				path: '/:org/*',
				loader: () => human,
				element: (
					<SidebarPanelProvider>
						<AppSidebar />
						<Page />
					</SidebarPanelProvider>
				),
			},
		],
		{initialEntries: [entry]},
	);

	render(
		<ThemeProvider>
			<TooltipProvider>
				<SidebarProvider>
					<UnreadContext.Provider value={unread}>
						<RouterProvider router={router} />
					</UnreadContext.Provider>
				</SidebarProvider>
			</TooltipProvider>
		</ThemeProvider>,
	);
	return router;
}

// Whether the sidebar shows the page's panel rather than the navigation.
function drilled(): boolean {
	const back = document.querySelector('button[aria-label="Chat, back to the menu"]');
	return back !== null && back.closest('[inert]') === null;
}

// The organization's pages in the sidebar, group by group.
function groupLabels(): string[][] {
	return [...document.querySelectorAll('[data-sidebar="content"] [data-sidebar="group"]')].map(
		(group) =>
			within(group as HTMLElement)
				.queryAllByRole('link')
				.map((link) => link.textContent),
	);
}

describe('AppSidebar', () => {
	test("groups the organization's pages, its members and settings in the switcher", async () => {
		renderSidebar(testHuman());
		const connections = await screen.findByRole('link', {name: 'Connections and permissions'});
		expect(connections.hasAttribute('data-active')).toBe(true);
		expect(
			screen.getByRole('button', {name: 'Organization: Acme'}).hasAttribute('data-active'),
		).toBe(false);

		expect(groupLabels()).toEqual([
			['Chat'],
			['Connections and permissions', 'External agents'],
			['Activity', 'Alerts'],
		]);

		fireEvent.click(screen.getByRole('button', {name: 'Organization: Acme'}));
		const members = await screen.findByRole('menuitem', {name: 'Members'});
		expect(members.getAttribute('href')).toBe('/acme/members');
		const settings = screen.getByRole('menuitem', {name: 'Settings'});
		expect(settings.getAttribute('href')).toBe('/acme/settings');
	});

	test('lights Chat in a conversation', async () => {
		renderSidebar(testHuman(), '/acme/chat/general');
		// Under its agents, which the sidebar shows on Chat.
		const chat = await screen.findByRole('link', {name: 'Chat', hidden: true});
		expect(chat.hasAttribute('data-active')).toBe(true);
	});

	test('counts the conversations with something unread on Chat', async () => {
		renderSidebar(testHuman(), '/acme/connections', unreadOf(['general', 'finance']));
		await screen.findByRole('link', {name: 'Chat'});

		const badge = screen.getByRole('status', {name: '2 unread'});
		expect(badge.textContent).toBe('2');
		expect(badge.closest('li')?.querySelector('a')?.textContent).toBe('Chat');
	});

	test("lands on the navigation, not on Chat's agents, in an organization switched to", async () => {
		const router = renderSidebar(testHuman(), '/acme/chat/general');
		await screen.findByRole('button', {name: 'Chat, back to the menu'});
		expect(drilled()).toBe(true);

		// As the switcher goes, landing on Chat through the redirects there.
		await act(() => router.navigate('/globex'));
		await act(() => router.navigate('/globex/chat', {replace: true}));
		await act(() => router.navigate('/globex/chat/general', {replace: true}));
		expect(drilled()).toBe(false);

		// Back to Chat from elsewhere in it, into its agents again.
		await act(() => router.navigate('/globex/connections'));
		await act(() => router.navigate('/globex/chat/general'));
		expect(drilled()).toBe(true);
	});

	test("lights the switcher on the organization's members and settings", async () => {
		renderSidebar(testHuman(), '/acme/members');

		const switcher = await screen.findByRole('button', {name: 'Organization: Acme'});
		expect(switcher.hasAttribute('data-active')).toBe(true);
		expect(
			screen
				.getAllByRole('link')
				.filter((link) => link.hasAttribute('data-active'))
				.map((link) => link.textContent),
		).toEqual([]);
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
		expect(account.getAttribute('href')).toBe('/account?org=acme');
		expect(avatar?.parentElement?.classList).toContain('size-4');
		expect(avatar?.classList).toContain('size-6');
		expect(image?.getAttribute('src')).toBe('https://example.com/ada.png');
	});
});
