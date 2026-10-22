/// <reference types="bun" />

import {afterEach, describe, expect, test} from 'bun:test';
import {cleanup, render, screen} from '@testing-library/react';
import {TooltipProvider} from '@proxy/ui/components/tooltip';
import {ThemeProvider} from '@proxy/ui/components/theme-provider';
import {createMemoryRouter, RouterProvider} from 'react-router';
import {HumanSide} from '@/components/human-side';
import {NewAgentPage} from '@/pages/new-agent-page';
import {testHuman} from '@/test-org';

afterEach(() => {
	cleanup();
});

function renderNewAgentPage() {
	const router = createMemoryRouter(
		[
			{
				id: 'human',
				path: '/:org',
				loader: () => testHuman(),
				element: <HumanSide />,
				children: [
					{
						path: '/:org/agents/new',
						loader: () => ({agents: []}),
						element: <NewAgentPage />,
					},
				],
			},
		],
		{initialEntries: ['/acme/agents/new']},
	);

	return render(
		<ThemeProvider>
			<TooltipProvider>
				<RouterProvider router={router} />
			</TooltipProvider>
		</ThemeProvider>,
	);
}

describe('NewAgentPage', () => {
	test('offers Claude Duet as its own product', async () => {
		renderNewAgentPage();

		const duet = await screen.findByRole('button', {name: /^Claude Duet/});
		expect(duet.querySelector('img')?.getAttribute('src')).toBe('/agent-providers/claude-duet.png');
	});
});
