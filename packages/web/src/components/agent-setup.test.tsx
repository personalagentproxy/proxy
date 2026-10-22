/// <reference types="bun" />

import {afterEach, beforeEach, describe, expect, mock, test} from 'bun:test';
import {act, cleanup, fireEvent, render, screen} from '@testing-library/react';
import {TooltipProvider} from '@proxy/ui/components/tooltip';
import {createMemoryRouter, RouterProvider} from 'react-router';
import {AddAgent, AgentSetup} from '@/components/agent-setup';
import type {AgentProviderId} from '@proxy/integrations';
import {pendingAgent} from '@/lib/pending-agent';
import type {AgentLogin} from '@/lib/types';

const realFetch = globalThis.fetch;
const fetchMock = mock<(input: string, init?: RequestInit) => Promise<Response>>();

beforeEach(() => {
	fetchMock.mockReset();
	fetchMock.mockImplementation(() => Promise.resolve(Response.json({clients: []})));
	globalThis.fetch = ((input: string, init?: RequestInit) =>
		fetchMock(input, init)) as typeof fetch;
	localStorage.clear();
});

afterEach(() => {
	cleanup();
	globalThis.fetch = realFetch;
});

function agentLogin(id: string, name: string, providerId: AgentProviderId = 'custom'): AgentLogin {
	return {
		id,
		providerId,
		name,
		username: `${name.toLowerCase().replace(/ /g, '-')}-k7q2`,
		shared: false,
		createdById: 'user-1',
		createdBy: null,
		createdAt: '2026-10-01T00:00:00Z',
		lastActiveAt: null,
		revokedAt: null,
		grants: [],
	};
}

function renderAgentSetup(agent: AgentLogin, onContinue: () => void = () => undefined) {
	const router = createMemoryRouter(
		[
			{
				path: '/:org/agents/:id/setup',
				element: <AgentSetup agent={agent} continueLabel="Continue" onContinue={onContinue} />,
			},
		],
		{initialEntries: [`/acme/agents/${agent.id}/setup`]},
	);

	return render(
		<TooltipProvider>
			<RouterProvider router={router} />
		</TooltipProvider>,
	);
}

function renderAddAgent(agents: AgentLogin[] = []) {
	const router = createMemoryRouter(
		[
			{
				path: '/:org/welcome/agent',
				element: <AddAgent agents={agents} continueLabel="Continue" onContinue={() => undefined} />,
			},
		],
		{initialEntries: ['/acme/welcome/agent']},
	);

	render(
		<TooltipProvider>
			<RouterProvider router={router} />
		</TooltipProvider>,
	);
	return router;
}

describe('AddAgent', () => {
	test('goes back to the choice of agent with the browser', async () => {
		const router = renderAddAgent();

		fireEvent.click(screen.getByRole('button', {name: /Claude Code/}));
		expect(screen.getByText('Name this Claude Code')).toBeDefined();
		expect(router.state.location.search).toBe('?provider=claude-code');

		await act(() => router.navigate(-1));
		expect(screen.getByText('Which agent do you use?')).toBeDefined();
	});

	test('makes the agent by the name given, however many of its kind there are, and sets it up', async () => {
		const made = agentLogin('agent-3', 'Claude Code at work', 'claude-code');
		fetchMock.mockImplementation((_input, init) =>
			Promise.resolve(
				init?.method === 'POST'
					? Response.json({agent: made, password: 'unused'})
					: Response.json({clients: []}),
			),
		);
		const router = renderAddAgent([
			agentLogin('agent-1', 'Claude Code', 'claude-code'),
			agentLogin('agent-2', 'Claude Code 2', 'claude-code'),
		]);

		fireEvent.click(screen.getByRole('button', {name: /Claude Code/}));
		const name = screen.getByLabelText('Name') as HTMLInputElement;
		expect(name.value).toBe('Claude Code');
		fireEvent.change(name, {target: {value: ' Claude Code at work '}});
		fireEvent.click(screen.getByRole('button', {name: 'Continue'}));

		expect(await screen.findByText('Add Personal Agent Proxy to Claude Code')).toBeDefined();
		expect(screen.getByText(/signed in as Claude Code at work/)).toBeDefined();
		expect(router.state.location.search).toBe('?agent=agent-3');
		const [url, init] = fetchMock.mock.calls[0] ?? [];
		expect(url).toBe('/api/orgs/acme/agents');
		expect(JSON.parse(String(init?.body))).toEqual({
			providerId: 'claude-code',
			name: 'Claude Code at work',
		});
		// The sign-in page Claude Code opens in this browser has it chosen.
		expect(pendingAgent()).toEqual({org: 'acme', agentId: 'agent-3'});
	});

	test('needs a custom agent named', () => {
		renderAddAgent();

		fireEvent.click(screen.getByRole('button', {name: /Custom MCP agent/}));
		expect(screen.getByText('Name your agent')).toBeDefined();
		expect((screen.getByRole('button', {name: 'Continue'}) as HTMLButtonElement).disabled).toBe(
			true,
		);
	});

	test('hands a login just made over with its password', async () => {
		const made = agentLogin('agent-1', 'Dots', 'dot');
		fetchMock.mockImplementation(() =>
			Promise.resolve(Response.json({agent: made, password: 'abcde-fghij-kmnop-qrstu'})),
		);
		const router = renderAddAgent();

		await act(() => router.navigate('/acme/welcome/agent?provider=dot'));
		fireEvent.click(screen.getByRole('button', {name: 'Continue'}));

		expect(await screen.findByText('Hand Dots its login')).toBeDefined();
		expect(screen.getByText(/Password: abcde-fghij-kmnop-qrstu/)).toBeDefined();
	});
	test('offers Claude and Claude Duet as separate products', () => {
		renderAddAgent();

		expect(screen.getByRole('button', {name: 'Claude Needs a public https address'})).toBeDefined();
		expect(
			screen.getByRole('button', {name: 'Claude Duet Needs a public https address'}),
		).toBeDefined();
	});

	test('makes Claude Duet a Claude login, and sets it up as Claude Duet', async () => {
		const made = agentLogin('agent-1', 'Claude', 'claude');
		fetchMock.mockImplementation((_input, init) =>
			Promise.resolve(
				init?.method === 'POST'
					? Response.json({agent: made, password: 'unused'})
					: Response.json({clients: []}),
			),
		);
		const router = renderAddAgent();

		await act(() => router.navigate('/acme/welcome/agent?provider=claude-duet'));
		expect((screen.getByLabelText('Name') as HTMLInputElement).value).toBe('Claude');
		fireEvent.click(screen.getByRole('button', {name: 'Continue'}));

		expect(await screen.findByText('Add Personal Agent Proxy to Claude Duet')).toBeDefined();
		expect(
			screen.getByText(/Claude Duet uses the connectors in your Claude account/),
		).toBeDefined();
		expect(screen.getByText(/Claude Duet shares that login/)).toBeDefined();
		expect(router.state.location.search).toBe('?agent=agent-1&provider=claude-duet');
		expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({
			providerId: 'claude-duet',
			name: 'Claude',
		});
	});
});

describe('AgentSetup', () => {
	test('shows the complete Hermes Agent command and remote OAuth handoff', () => {
		renderAgentSetup(agentLogin('agent-1', 'Hermes Agent', 'hermes'));

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
		renderAgentSetup(agentLogin('agent-1', 'Claude Code', 'claude-code'));

		expect(
			screen.getByText('claude mcp add --transport http personal-agent-proxy http://localhost/mcp'),
		).toBeDefined();
		expect(
			screen.getByText('In Claude Code, run /mcp and choose personal-agent-proxy to sign in.'),
		).toBeDefined();
		expect(
			screen.getByText(
				'Claude Code opens Personal Agent Proxy to sign in. Allow it to work as Claude Code.',
			),
		).toBeDefined();
	});

	test('adds Claude through its Claude account connector', () => {
		renderAgentSetup(agentLogin('agent-1', 'Claude', 'claude'));

		expect(screen.getByRole('link', {name: 'Open Claude'}).getAttribute('href')).toBe(
			'https://claude.ai/customize/connectors',
		);
		expect(screen.getByText(/choose Register automatically under OAuth client/)).toBeDefined();
		expect(screen.getByText(/Allow it to work as Claude\./)).toBeDefined();
	});

	test('waits for an MCP client to sign in as the agent, then says which did', async () => {
		fetchMock.mockImplementation(() =>
			Promise.resolve(
				Response.json({
					clients: [
						{
							id: 'grant-1',
							name: 'Cursor',
							connectedAt: '2026-10-01T00:00:00Z',
							connectedBy: null,
							mine: true,
						},
					],
				}),
			),
		);
		renderAgentSetup(agentLogin('agent-1', 'Coding agent'));

		expect(screen.getByText('Add Personal Agent Proxy to Coding agent')).toBeDefined();
		expect(await screen.findByText('Cursor is signed in as Coding agent.')).toBeDefined();
		expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/orgs/acme/agents/agent-1/mcp-clients');
		expect(pendingAgent()).toBeNull();
	});

	test('sets a login up again with a new password', () => {
		renderAgentSetup(agentLogin('agent-1', 'Dots', 'dot'));

		expect(screen.getByText(/Dots's login is dots-k7q2/)).toBeDefined();
		expect(screen.getByRole('button', {name: 'New password'})).toBeDefined();
	});

	test('continues with Command+Enter', () => {
		let continued = 0;
		renderAgentSetup(agentLogin('agent-1', 'Coding agent'), () => continued++);

		fireEvent.keyDown(window, {key: 'Enter', metaKey: true});

		expect(continued).toBe(1);
	});
});
