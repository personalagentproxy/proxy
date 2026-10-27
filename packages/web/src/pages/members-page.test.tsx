/// <reference types="bun" />

import {afterEach, describe, expect, test} from 'bun:test';
import {cleanup, render, screen} from '@testing-library/react';
import {createMemoryRouter, RouterProvider} from 'react-router';
import {ThemeProvider} from '@proxy/ui/components/theme-provider';
import {TooltipProvider} from '@proxy/ui/components/tooltip';
import {HumanSide} from '@/components/human-side';
import {MembersPage} from '@/pages/members-page';
import {testHuman} from '@/test-org';

afterEach(() => {
	cleanup();
});

describe('MembersPage', () => {
	test('shows Google profile images and initial fallbacks for members', async () => {
		const router = createMemoryRouter(
			[
				{
					id: 'human',
					loader: () => testHuman(),
					element: <HumanSide />,
					children: [
						{
							path: '/:org/members',
							loader: () => ({
								members: [
									{
										userId: 'user-1',
										name: 'Ada Lovelace',
										email: 'ada@example.com',
										image: 'https://example.com/ada.png',
										role: 'owner' as const,
										joinedAt: '2026-10-21T00:00:00.000Z',
									},
									{
										userId: 'user-2',
										name: null,
										email: 'grace@example.com',
										image: null,
										role: 'member' as const,
										joinedAt: '2026-10-22T00:00:00.000Z',
									},
								],
								invitations: [],
							}),
							element: <MembersPage />,
						},
					],
				},
			],
			{initialEntries: ['/acme/members']},
		);

		render(
			<ThemeProvider>
				<TooltipProvider>
					<RouterProvider router={router} />
				</TooltipProvider>
			</ThemeProvider>,
		);

		const ada = await screen.findByText(/Ada Lovelace/);
		const adaRow = ada.closest('li');
		const image = adaRow?.querySelector('img');
		expect(adaRow?.textContent).toContain('You');
		expect(image?.getAttribute('src')).toBe('https://example.com/ada.png');

		const [grace] = screen.getAllByText('grace@example.com');
		expect(grace).toBeDefined();
		if (!grace) {
			return;
		}
		const graceRow = grace.closest('li');
		expect(graceRow?.querySelector('img')).toBeNull();
		expect(graceRow?.querySelector('[data-slot="person-avatar"]')?.textContent).toBe('G');
	});
});
