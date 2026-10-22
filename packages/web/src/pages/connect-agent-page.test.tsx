/// <reference types="bun" />

import {afterEach, describe, expect, test} from 'bun:test';
import {cleanup, render, screen} from '@testing-library/react';
import {createMemoryRouter, RouterProvider} from 'react-router';
import type {Org} from '@/client/orgs-client';
import type {AgentLogin} from '@/lib/types';
import {ConnectAgentPage} from '@/pages/connect-agent-page';

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

const claude: AgentLogin = {
	id: 'agent-1',
	providerId: 'claude',
	name: 'Claude',
	username: 'claude-k7q2',
	shared: false,
	createdById: 'user-1',
	createdBy: null,
	createdAt: '2026-10-01T00:00:00Z',
	lastActiveAt: null,
	revokedAt: null,
	grants: [],
};

function renderConsent(agents: AgentLogin[]) {
	const router = createMemoryRouter(
		[
			{
				path: '/agent-auth/connect',
				loader: () => ({
					kind: 'ok',
					request: 'sealed-request',
					details: {
						clientName: 'Claude Duet',
						redirectHost: 'claude.ai',
						suggestedProviderId: 'claude',
					},
					orgs: [org],
					org: org.slug,
					agents,
					pendingAgentId: null,
				}),
				element: <ConnectAgentPage />,
			},
		],
		{initialEntries: ['/agent-auth/connect']},
	);

	render(<RouterProvider router={router} />);
}

describe('ConnectAgentPage', () => {
	test('connects Claude Duet through an existing Claude login', async () => {
		renderConsent([claude]);

		const existing = await screen.findByRole('radio', {name: 'Claude Anthropic'});
		expect(existing).toHaveProperty('checked', true);
		expect(screen.queryByRole('radio', {name: /Claude Duet/})).toBeNull();
	});

	test('offers one canonical Claude login when Claude Duet has none yet', async () => {
		renderConsent([]);

		const newClaude = await screen.findByRole('radio', {name: 'Claude New login'});
		expect(newClaude).toHaveProperty('checked', true);
		expect(screen.queryByRole('radio', {name: /Claude Duet/})).toBeNull();
	});
});
