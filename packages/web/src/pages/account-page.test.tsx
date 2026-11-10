/// <reference types="bun" />

import {afterEach, beforeEach, describe, expect, mock, test} from 'bun:test';
import {cleanup, fireEvent, render, screen, waitFor} from '@testing-library/react';
import {Ok} from 'ts-results-es';
import {createMemoryRouter, RouterProvider} from 'react-router';
import {ThemeProvider} from '@proxy/ui/components/theme-provider';
import {TooltipProvider} from '@proxy/ui/components/tooltip';
import type {ClaudeAccount} from '@proxy/contracts/me';
import {HumanSide} from '@/components/human-side';
import {formatDateTime} from '@/lib/format';
import {later} from '@/lib/loader-utils';
import {AccountPage} from '@/pages/account-page';
import {testHuman} from '@/test-org';

const connectClaudeToken = mock(async () => Ok({account: null}));
const disconnectClaude = mock(async () => Ok({account: null}));
mock.module('@/client/me-client', () => ({
	getMe: mock(),
	deleteAccount: mock(),
	listSessions: mock(),
	deleteSession: mock(),
	deleteOtherSessions: mock(),
	getClaudeAccount: mock(),
	connectClaudeToken,
	disconnectClaude,
}));
mock.module('@/client/auth-client', () => ({signOut: mock()}));

beforeEach(() => {
	mock.clearAllMocks();
});

afterEach(() => {
	cleanup();
	delete window.personalAgentProxyDesktop;
});

const session = {
	id: 'session-1',
	client: 'Chrome',
	os: 'macOS',
	createdAt: '2026-11-01T10:00:00.000Z',
	current: true,
};

const DAY_MS = 24 * 60 * 60 * 1000;

// A token with most of its year left.
const token: ClaudeAccount['account'] = {
	kind: 'setup_token',
	expiresAt: '2027-11-09T12:00:00.000Z',
	failure: null,
	connectedAt: '2026-11-09T12:00:00.000Z',
	usage: null,
};

// The desktop app's window, with its Claude sign-in answering as told.
function desktopWith(signIn: {
	start: () => Promise<{ok: true} | {error: string}>;
	finish: (code: string) => Promise<{token: string; expiresAt: string} | {error: string}>;
}) {
	const start = mock(signIn.start);
	const finish = mock(signIn.finish);
	window.personalAgentProxyDesktop = {
		updateReady: async () => null,
		onUpdateReady: () => () => undefined,
		restart: () => undefined,
		claudeSignIn: {start, finish},
	};
	return {start, finish};
}

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
						loader: later(async () => ({sessions: [session], claude})),
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
	test('not connected, it says what connecting is for, shows the command to run with a copy button, takes a pasted token, and points to the desktop app', async () => {
		renderPage(null);
		expect(
			await screen.findByText(/Run the built-in agent on your own Claude subscription/),
		).toBeDefined();
		expect(screen.getByRole('button', {name: 'Copy command'})).toBeDefined();
		expect(screen.getByText('Or connect from the desktop app.')).toBeDefined();

		const field = screen.getByLabelText(/Paste a token from/);
		fireEvent.change(field, {target: {value: 'sk-ant-oat01-abc'}});
		fireEvent.click(screen.getByRole('button', {name: 'Connect'}));
		await waitFor(() => expect(connectClaudeToken).toHaveBeenCalledWith('sk-ant-oat01-abc'));
	});

	test('connected with a token, it says so and until when, offers no form, and disconnects', async () => {
		renderPage(token);
		expect(await screen.findByText('Connected with a Claude token.')).toBeDefined();
		const until = screen.getByText(/Signed in until Nov 9, 2027\./);
		expect(until.className).not.toContain('text-destructive');
		expect(screen.queryByText(/Connect again/)).toBeNull();
		expect(screen.queryByLabelText(/Paste a token from/)).toBeNull();

		fireEvent.click(screen.getByRole('button', {name: 'Disconnect'}));
		await waitFor(() => expect(disconnectClaude).toHaveBeenCalledTimes(1));
	});

	test('connected with an API key, it says which kind and nothing of an end', async () => {
		renderPage({...token, kind: 'api_key', expiresAt: null});
		expect(await screen.findByText('Connected with an API key.')).toBeDefined();
		expect(screen.queryByText(/Signed in until/)).toBeNull();
	});

	test('a token near its end is shown in red with the way to connect again, and the form is back', async () => {
		renderPage({...token, expiresAt: new Date(Date.now() + 10 * DAY_MS).toISOString()});
		const until = await screen.findByText(/Signed in until .* Connect again soon\./);
		expect(until.className).toContain('text-destructive');
		expect(screen.getByLabelText(/Paste a token from/)).toBeDefined();
	});

	test('a refused credential is shown in red, with the form to connect again', async () => {
		renderPage({
			...token,
			failure:
				'Your Claude sign-in has run out or was refused. Connect it again on the Account page.',
		});
		const failure = await screen.findByText(/run out or was refused/);
		expect(failure.className).toContain('text-destructive');
		expect(screen.getByLabelText(/Paste a token from/)).toBeDefined();
	});

	test('the plan’s usage as the last turn had it: each window spoken of, its reset, and when that was', async () => {
		renderPage({
			...token,
			usage: {
				fiveHour: {utilization: 0.37, resetsAt: '2026-11-10T15:00:00.000Z'},
				sevenDay: {utilization: 0.125, resetsAt: null},
				readAt: '2026-11-10T12:30:00.000Z',
			},
		});
		expect(
			await screen.findByText(
				`5-hour window: 37% used, resets ${formatDateTime('2026-11-10T15:00:00.000Z')}`,
			),
		).toBeDefined();
		expect(screen.getByText('7-day window: 13% used')).toBeDefined();
		expect(screen.getByText(`As of ${formatDateTime('2026-11-10T12:30:00.000Z')}.`)).toBeDefined();
	});

	test('in the desktop app, not connected, Connect Claude opens Claude, takes the pasted code, and connects the token the app minted', async () => {
		const {start, finish} = desktopWith({
			start: async () => ({ok: true}),
			finish: async () => ({token: 'sk-ant-oat01-minted', expiresAt: '2027-11-10T12:00:00.000Z'}),
		});
		renderPage(null);
		expect(
			await screen.findByText(/Run the built-in agent on your own Claude subscription/),
		).toBeDefined();
		expect(screen.queryByLabelText(/Paste a token from/)).toBeNull();
		expect(screen.queryByText('Or connect from the desktop app.')).toBeNull();

		fireEvent.click(screen.getByRole('button', {name: 'Connect Claude'}));
		await waitFor(() => expect(start).toHaveBeenCalledTimes(1));
		const field = await screen.findByLabelText('Paste the code from Claude');
		expect(screen.getByRole('button', {name: 'Open Claude again'})).toBeDefined();

		fireEvent.change(field, {target: {value: 'the-code#the-state'}});
		fireEvent.click(screen.getByRole('button', {name: 'Connect'}));
		await waitFor(() => expect(finish).toHaveBeenCalledWith('the-code#the-state'));
		await waitFor(() =>
			expect(connectClaudeToken).toHaveBeenCalledWith(
				'sk-ant-oat01-minted',
				'2027-11-10T12:00:00.000Z',
			),
		);
	});

	test('in the desktop app, what went wrong with the code is shown, the field stays, and Open Claude again starts over', async () => {
		const {start, finish} = desktopWith({
			start: async () => ({ok: true}),
			finish: async () => ({error: 'Paste the complete code from Claude.'}),
		});
		renderPage(null);
		fireEvent.click(await screen.findByRole('button', {name: 'Connect Claude'}));
		const field = await screen.findByLabelText('Paste the code from Claude');

		fireEvent.change(field, {target: {value: 'the-code'}});
		fireEvent.click(screen.getByRole('button', {name: 'Connect'}));
		const shown = await screen.findByText('Paste the complete code from Claude.');
		expect(shown.className).toContain('text-destructive');
		expect(screen.getByLabelText('Paste the code from Claude')).toBeDefined();
		expect(connectClaudeToken).not.toHaveBeenCalled();

		fireEvent.click(screen.getByRole('button', {name: 'Open Claude again'}));
		await waitFor(() => expect(start).toHaveBeenCalledTimes(2));
		expect(finish).toHaveBeenCalledTimes(1);
	});

	test('in the desktop app, a Claude page that could not be opened is said so', async () => {
		desktopWith({
			start: async () => ({error: 'Claude sign-in failed. Try again.'}),
			finish: async () => ({error: 'unreached'}),
		});
		renderPage(null);
		fireEvent.click(await screen.findByRole('button', {name: 'Connect Claude'}));
		expect(await screen.findByText('Claude sign-in failed. Try again.')).toBeDefined();
		expect(screen.queryByLabelText('Paste the code from Claude')).toBeNull();
	});

	test('in the desktop app, pasting a token is the alternative, behind a link, and connects as in the browser', async () => {
		desktopWith({
			start: async () => ({ok: true}),
			finish: async () => ({error: 'unreached'}),
		});
		renderPage({...token, expiresAt: new Date(Date.now() + 10 * DAY_MS).toISOString()});
		expect(await screen.findByRole('button', {name: 'Connect Claude'})).toBeDefined();

		fireEvent.click(screen.getByRole('button', {name: 'Paste a token instead'}));
		const field = screen.getByLabelText(/Paste a token from/);
		expect(screen.queryByText('Or connect from the desktop app.')).toBeNull();
		fireEvent.change(field, {target: {value: 'sk-ant-api03-key'}});
		fireEvent.click(screen.getByRole('button', {name: 'Connect'}));
		await waitFor(() => expect(connectClaudeToken).toHaveBeenCalledWith('sk-ant-api03-key'));
	});
});
