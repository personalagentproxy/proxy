/// <reference types="bun" />

import {afterEach, beforeEach, describe, expect, mock, spyOn, test} from 'bun:test';
import {cleanup, fireEvent, render, screen, waitFor} from '@testing-library/react';
import {Ok} from 'ts-results-es';
import {createMemoryRouter, RouterProvider} from 'react-router';
import {ThemeProvider} from '@proxy/ui/components/theme-provider';
import {TooltipProvider} from '@proxy/ui/components/tooltip';
import type {ClaudeAccount} from '@proxy/contracts/me';
import {HumanSide} from '@/components/human-side';
import {AccountPage} from '@/pages/account-page';
import {testHuman} from '@/test-org';

const beginClaudeSignIn = mock(async () =>
	Ok({authorizeUrl: 'https://claude.com/cai/oauth/authorize?state=st'}),
);
const finishClaudeSignIn = mock(async () => Ok({account: null}));
const connectClaudeToken = mock(async () => Ok({account: null}));
const disconnectClaude = mock(async () => Ok({account: null}));
mock.module('@/client/me-client', () => ({
	getMe: mock(),
	deleteAccount: mock(),
	listSessions: mock(),
	deleteSession: mock(),
	deleteOtherSessions: mock(),
	getClaudeAccount: mock(),
	beginClaudeSignIn,
	finishClaudeSignIn,
	connectClaudeToken,
	disconnectClaude,
}));
mock.module('@/client/auth-client', () => ({signOut: mock()}));

const open = spyOn(window, 'open').mockImplementation(() => null);

beforeEach(() => {
	mock.clearAllMocks();
});

afterEach(() => {
	cleanup();
});

const session = {
	id: 'session-1',
	client: 'Chrome',
	os: 'macOS',
	createdAt: '2026-11-01T10:00:00.000Z',
	current: true,
};

const subscription: ClaudeAccount['account'] = {
	kind: 'oauth',
	email: 'dana@example.com',
	subscriptionType: 'max',
	expiresAt: '2026-11-09T20:00:00.000Z',
	failure: null,
	connectedAt: '2026-11-09T12:00:00.000Z',
};

function renderPage(claude: ClaudeAccount['account']) {
	const router = createMemoryRouter(
		[
			{
				id: 'human',
				loader: () => testHuman(),
				element: <HumanSide />,
				children: [
					{
						path: '/account',
						loader: () => ({sessions: [session], claude}),
						element: <AccountPage />,
					},
				],
			},
		],
		{initialEntries: ['/account']},
	);
	return render(
		<ThemeProvider>
			<TooltipProvider>
				<RouterProvider router={router} />
			</TooltipProvider>
		</ThemeProvider>,
	);
}

describe('AccountPage, the Claude card', () => {
	test('not connected, it says what connecting is for and offers to', async () => {
		renderPage(null);
		expect(
			await screen.findByText(/Run the built-in agent on your own Claude subscription/),
		).toBeDefined();
		expect(screen.getByRole('button', {name: 'Connect Claude'})).toBeDefined();
		expect(screen.queryByLabelText('Paste the code from Claude')).toBeNull();
	});

	test("connecting opens Claude's sign-in in a new tab and asks for the code, which connects", async () => {
		renderPage(null);
		fireEvent.click(await screen.findByRole('button', {name: 'Connect Claude'}));

		await waitFor(() => expect(beginClaudeSignIn).toHaveBeenCalledTimes(1));
		expect(open).toHaveBeenCalledWith(
			'https://claude.com/cai/oauth/authorize?state=st',
			'_blank',
			'noopener',
		);
		const field = await screen.findByLabelText('Paste the code from Claude');
		expect(screen.getByRole('link', {name: 'Open Claude again'}).getAttribute('href')).toBe(
			'https://claude.com/cai/oauth/authorize?state=st',
		);

		fireEvent.change(field, {target: {value: 'the-code#st'}});
		fireEvent.click(screen.getByRole('button', {name: 'Connect'}));
		await waitFor(() => expect(finishClaudeSignIn).toHaveBeenCalledWith('the-code#st'));
	});

	test('a setup token or API key is pasted instead, behind a disclosure', async () => {
		renderPage(null);
		fireEvent.click(
			await screen.findByRole('button', {name: 'Paste a setup token or API key instead'}),
		);
		const field = await screen.findByLabelText('Setup token or API key');
		fireEvent.change(field, {target: {value: 'sk-ant-oat01-abc'}});
		fireEvent.click(screen.getByRole('button', {name: 'Connect'}));
		await waitFor(() => expect(connectClaudeToken).toHaveBeenCalledWith('sk-ant-oat01-abc'));
	});

	test('connected with a subscription, it names the account, the plan, and disconnects', async () => {
		renderPage(subscription);
		expect(await screen.findByText('Connected with a Claude subscription.')).toBeDefined();
		expect(screen.getByText('dana@example.com · Max plan')).toBeDefined();
		expect(screen.queryByRole('button', {name: /Connect/})).toBeNull();

		fireEvent.click(screen.getByRole('button', {name: 'Disconnect'}));
		await waitFor(() => expect(disconnectClaude).toHaveBeenCalledTimes(1));
	});

	test('connected with a token, it says which kind and nothing of an expiry', async () => {
		renderPage({
			...subscription,
			kind: 'setup_token',
			email: null,
			subscriptionType: null,
			expiresAt: null,
		});
		expect(await screen.findByText('Connected with a setup token.')).toBeDefined();
	});

	test('a refused refresh is shown in red, with the way to connect again', async () => {
		renderPage({
			...subscription,
			failure: 'Your Claude sign-in expired or was refused. Connect it again on the Account page.',
		});
		const failure = await screen.findByText(/expired or was refused/);
		expect(failure.className).toContain('text-destructive');
		fireEvent.click(screen.getByRole('button', {name: 'Connect again'}));
		await waitFor(() => expect(beginClaudeSignIn).toHaveBeenCalledTimes(1));
		expect(await screen.findByLabelText('Paste the code from Claude')).toBeDefined();
	});
});
