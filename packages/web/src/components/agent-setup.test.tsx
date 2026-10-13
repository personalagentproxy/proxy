/// <reference types="bun" />

import {afterEach, describe, expect, test} from 'bun:test';
import {act, cleanup, fireEvent, render, screen} from '@testing-library/react';
import {TooltipProvider} from '@proxy/ui/components/tooltip';
import {createMemoryRouter, RouterProvider} from 'react-router';
import {AgentSetup} from '@/components/agent-setup';
import {AGENT_PROVIDERS, findAgentProvider, type AgentProviderId} from '@proxy/integrations';

afterEach(() => {
	cleanup();
});

function renderAgentSetup(providerId: AgentProviderId) {
	const provider = findAgentProvider(providerId);
	if (!provider) {
		throw new Error(`${providerId} provider is missing`);
	}

	const router = createMemoryRouter(
		[
			{
				path: '/',
				element: (
					<AgentSetup
						agents={[]}
						providers={[provider]}
						fixed={providerId}
						continueLabel="Continue"
						onContinue={() => undefined}
					/>
				),
			},
		],
		{initialEntries: ['/']},
	);

	return render(
		<TooltipProvider>
			<RouterProvider router={router} />
		</TooltipProvider>,
	);
}

function renderAgentChoice() {
	const router = createMemoryRouter(
		[
			{
				path: '/welcome',
				element: (
					<AgentSetup
						agents={[]}
						providers={AGENT_PROVIDERS}
						continueLabel="Continue"
						onContinue={() => undefined}
					/>
				),
			},
		],
		{initialEntries: ['/welcome']},
	);

	render(
		<TooltipProvider>
			<RouterProvider router={router} />
		</TooltipProvider>,
	);
	return router;
}

describe('AgentSetup', () => {
	test('goes back to the choice of agent with the browser', async () => {
		const router = renderAgentChoice();

		fireEvent.click(screen.getByRole('button', {name: /Claude Code/}));
		expect(screen.getByText('Add Personal Agent Proxy to Claude Code')).toBeDefined();
		expect(router.state.location.search).toBe('?agent=claude-code');

		await act(() => router.navigate(-1));
		expect(screen.getByText('Which agent do you use?')).toBeDefined();
	});

	test('shows the complete Hermes Agent command and remote OAuth handoff', () => {
		renderAgentSetup('hermes');

		expect(
			screen.getByText(
				"hermes mcp add personal-agent-proxy --url 'http://localhost/mcp' --auth oauth --connect-timeout 300",
			),
		).toBeDefined();
		expect(
			screen.getByText(/copy the full redirect URL from the browser back into its prompt/),
		).toBeDefined();
	});

	test('keeps the generic command-based setup steps for Claude Code', () => {
		renderAgentSetup('claude-code');

		expect(
			screen.getByText('claude mcp add --transport http personal-agent-proxy http://localhost/mcp'),
		).toBeDefined();
		expect(
			screen.getByText('In Claude Code, run /mcp and choose personal-agent-proxy to sign in.'),
		).toBeDefined();
		expect(screen.getByText(/Claude Code opens Personal Agent Proxy to sign in/)).toBeDefined();
	});
});
