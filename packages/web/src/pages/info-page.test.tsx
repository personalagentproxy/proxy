/// <reference types="bun" />

import {afterEach, describe, expect, test} from 'bun:test';
import {cleanup, fireEvent, render, screen, waitFor, within} from '@testing-library/react';
import {createMemoryRouter, RouterProvider} from 'react-router';
import {TooltipProvider} from '@proxy/ui/components/tooltip';
import {ThemeProvider} from '@proxy/ui/components/theme-provider';
import {HumanSide} from '@/components/human-side';
import {InfoPage} from '@/pages/info-page';

afterEach(() => {
	cleanup();
});

function renderInfoPage() {
	const router = createMemoryRouter(
		[
			{
				id: 'human',
				loader: () => ({
					user: {id: 'user-1', email: 'person@example.com', name: null, image: null},
					onboarded: true,
				}),
				element: <HumanSide />,
				children: [
					{
						path: '/info',
						loader: () => ({
							connectionId: 'info-1',
							records: {
								addresses: [{id: 'address-1', values: {}, updatedAt: '2026-10-09T00:00:00.000Z'}],
								cards: [],
								notes: [],
							},
						}),
						element: <InfoPage />,
					},
				],
			},
		],
		{initialEntries: ['/info']},
	);

	return render(
		<ThemeProvider>
			<TooltipProvider>
				<RouterProvider router={router} />
			</TooltipProvider>
		</ThemeProvider>,
	);
}

function sectionNamed(name: string): HTMLElement {
	const section = screen.getByRole('heading', {name}).closest('section');
	if (!section) {
		throw new Error(`${name} did not render in a section`);
	}
	return section;
}

describe('InfoPage', () => {
	test('requires a value for every new Information record but not for an existing one', async () => {
		renderInfoPage();
		await screen.findByRole('heading', {name: 'Addresses'});

		for (const name of ['Addresses', 'Payment cards', 'Notes']) {
			const section = sectionNamed(name);
			fireEvent.click(within(section).getByRole('button', {name: 'Add'}));
			expect(await screen.findByRole('button', {name: 'Save'})).toHaveProperty('disabled', true);
			fireEvent.click(screen.getByRole('button', {name: 'Cancel'}));
			await waitFor(() => expect(screen.queryByRole('button', {name: 'Save'})).toBeNull());
		}

		fireEvent.click(
			within(sectionNamed('Addresses')).getByRole('button', {name: 'Untitled address'}),
		);
		expect(await screen.findByRole('button', {name: 'Save'})).toHaveProperty('disabled', false);
	});
});
