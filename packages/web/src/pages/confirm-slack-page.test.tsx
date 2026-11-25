/// <reference types="bun" />

import {afterEach, beforeEach, describe, expect, mock, test} from 'bun:test';
import {cleanup, fireEvent, render, screen} from '@testing-library/react';
import {Err, Ok} from 'ts-results-es';
import {createMemoryRouter, RouterProvider} from 'react-router';
import type {SlackConfirmation, SlackConfirmed} from '@proxy/contracts/slack';
import type {FetchError} from '@proxy/utils';
import {ConfirmSlackPage} from '@/pages/confirm-slack-page';

const confirmSlackLink = mock(
	async (_token: string): Promise<Ok<SlackConfirmed> | Err<FetchError>> =>
		Ok({
			personaName: 'Travel',
			takenUp: true,
			slackUrl: 'https://slack.com/app_redirect?app=A01&team=T01',
		}),
);
mock.module('@/client/slack-client', () => ({
	confirmSlackLink,
	getSlackLink: mock(),
	listSlackLinks: mock(),
}));
const signOut = mock();
mock.module('@/client/auth-client', () => ({signOut}));

beforeEach(() => {
	mock.clearAllMocks();
});

afterEach(() => {
	cleanup();
});

const me = {user: {id: 'user-1', email: 'person@example.com', name: null, image: null}};

function renderPage(confirmation: SlackConfirmation | null) {
	const router = createMemoryRouter(
		[
			{
				path: '/confirm-slack/:token',
				loader: () => ({me, confirmation}),
				element: <ConfirmSlackPage />,
			},
		],
		{initialEntries: ['/confirm-slack/payload.signature']},
	);
	render(<RouterProvider router={router} />);
}

const confirm: SlackConfirmation = {
	state: 'confirm',
	workspaceName: 'Northwind',
	orgName: 'Northwind & Co',
	personaName: 'Travel',
	linked: false,
};

describe('ConfirmSlackPage', () => {
	test('a member confirms with one button, and is told their message is with the persona, with the way back to Slack', async () => {
		renderPage(confirm);

		expect(await screen.findByText('Confirm it’s you in Northwind')).toBeTruthy();
		expect(screen.getByText(/to you, person@example.com, in Northwind & Co/)).toBeTruthy();
		expect(screen.getByText(/is answered in Slack, with the agent working as you/)).toBeTruthy();
		fireEvent.click(screen.getByRole('button', {name: 'Confirm'}));

		expect(await screen.findByText('You’re linked')).toBeTruthy();
		expect(confirmSlackLink).toHaveBeenCalledWith('payload.signature');
		expect(screen.getByText(/Travel has your message/)).toBeTruthy();
		expect(screen.getByText(/It answers you in Slack, under your message/)).toBeTruthy();
		expect(screen.getByRole('button', {name: 'Back to Slack'}).getAttribute('href')).toBe(
			'https://slack.com/app_redirect?app=A01&team=T01',
		);
	});

	test('where the message couldn’t be taken up, asks them to write it again', async () => {
		confirmSlackLink.mockResolvedValueOnce(
			Ok({
				personaName: 'Travel',
				takenUp: false,
				slackUrl: 'https://slack.com/app_redirect?app=A01&team=T01',
			}),
		);
		renderPage(confirm);

		fireEvent.click(await screen.findByRole('button', {name: 'Confirm'}));

		expect(await screen.findByText(/Write to Travel in Slack again/)).toBeTruthy();
	});

	test('says what went wrong confirming, and stays', async () => {
		const refused: FetchError = {
			kind: 'http',
			url: '/api/slack-links/x',
			status: 409,
			body: {
				error: 'conflict',
				message: 'This Slack account is linked to someone else in Northwind & Co.',
			},
		};
		confirmSlackLink.mockResolvedValueOnce(Err(refused));
		renderPage(confirm);

		fireEvent.click(await screen.findByRole('button', {name: 'Confirm'}));

		expect(await screen.findByText(/linked to someone else/)).toBeTruthy();
		expect(screen.queryByText('You’re linked')).toBeNull();
	});

	test('someone not in the organization is told whom to ask, and nothing is linked', async () => {
		renderPage({
			state: 'not_member',
			workspaceName: 'Northwind',
			orgName: 'Northwind & Co',
			ownerName: 'Dana',
		});

		expect(await screen.findByText('You’re not in Northwind & Co')).toBeTruthy();
		expect(screen.getByText(/Ask Dana to invite you to Northwind & Co/)).toBeTruthy();
		expect(screen.queryByRole('button', {name: 'Confirm'})).toBeNull();
	});

	test('a link that has run out, one that isn’t one, and a Slack account another member’s', async () => {
		renderPage({state: 'expired'});
		expect(await screen.findByText('This link has run out')).toBeTruthy();
		cleanup();

		renderPage(null);
		expect(await screen.findByText('This link isn’t valid')).toBeTruthy();
		cleanup();

		renderPage({state: 'taken', workspaceName: 'Northwind', orgName: 'Northwind & Co'});
		expect(await screen.findByText('This Slack account is someone else’s here')).toBeTruthy();
	});
});
