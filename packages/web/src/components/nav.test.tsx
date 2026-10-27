/// <reference types="bun" />

import {afterEach, describe, expect, test} from 'bun:test';
import {cleanup, render, screen} from '@testing-library/react';
import {createMemoryRouter, RouterProvider} from 'react-router';
import {SidebarProvider} from '@proxy/ui/components/sidebar';
import {ThemeProvider} from '@proxy/ui/components/theme-provider';
import {TooltipProvider} from '@proxy/ui/components/tooltip';
import {AppSidebar} from '@/components/nav';
import {testHuman} from '@/test-org';

afterEach(() => {
	cleanup();
});

describe('AppSidebar', () => {
	test('links the signed-in Google profile image to Account', async () => {
		const human = testHuman();
		human.user = {
			...human.user,
			name: 'Ada Lovelace',
			image: 'https://example.com/ada.png',
		};
		const router = createMemoryRouter(
			[
				{
					id: 'human',
					path: '/:org',
					loader: () => human,
					element: <AppSidebar />,
				},
			],
			{initialEntries: ['/acme']},
		);

		render(
			<ThemeProvider>
				<TooltipProvider>
					<SidebarProvider>
						<RouterProvider router={router} />
					</SidebarProvider>
				</TooltipProvider>
			</ThemeProvider>,
		);

		const account = await screen.findByRole('link', {name: 'Account'});
		const avatar = account.querySelector('[data-slot="person-avatar"]');
		const image = account.querySelector('img');
		expect(account.getAttribute('href')).toBe('/account');
		expect(avatar?.parentElement?.classList).toContain('size-4');
		expect(avatar?.classList).toContain('size-6');
		expect(image?.getAttribute('src')).toBe('https://example.com/ada.png');
	});
});
