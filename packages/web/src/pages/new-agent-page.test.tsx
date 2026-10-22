/// <reference types="bun" />

import {afterEach, describe, expect, test} from 'bun:test';
import {cleanup, render, screen} from '@testing-library/react';
import {TooltipProvider} from '@proxy/ui/components/tooltip';
import {ThemeProvider} from '@proxy/ui/components/theme-provider';
import {createMemoryRouter, RouterProvider} from 'react-router';
import type {Org} from '@/client/orgs-client';
import {HumanSide} from '@/components/human-side';
import type {Human} from '@/lib/orgs';
import type {AgentLogin} from '@/lib/types';
import {NewAgentPage} from '@/pages/new-agent-page';

afterEach(() => {
	cleanup();
});

const org: Org = {
	id: 'org-1',
	slug: 'acme',
	name: 'Acme',
	role: 'owner',
	onboarded: true,
	experiments: [],
	memberCount: 1,
	invitationCount: 0,
};

function claudeLogin(revokedAt: string | null): AgentLogin {
	return {
		id: 'agent-1',
		providerId: 'claude',
		name: 'Claude',
		username: 'claude-k7q2',
		shared: false,
		createdById: 'user-1',
		createdBy: null,
		createdAt: '2026-10-01T00:00:00Z',
		lastActiveAt: null,
		revokedAt,
		grants: [],
	};
}

function renderNewAgentPage(agents: AgentLogin[]) {
	const human: Human = {
		user: {id: 'user-1', email: 'person@example.com', name: null, image: null},
		org,
		orgs: [org],
	};
	const router = createMemoryRouter(
		[
			{
				id: 'human',
				path: '/:org',
				loader: () => human,
				element: <HumanSide />,
				children: [
					{
						path: '/:org/agents/new',
						loader: () => ({agents}),
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
	test('offers Claude Duet as its own product, whatever Claude logins there are', async () => {
		for (const agents of [[], [claudeLogin(null)], [claudeLogin('2026-10-21T00:00:00Z')]]) {
			renderNewAgentPage(agents);

			const duet = await screen.findByRole('button', {name: /^Claude Duet/});
			expect(duet.querySelector('img')?.getAttribute('src')).toBe(
				'/agent-providers/claude-duet.png',
			);
			cleanup();
		}
	});
});
