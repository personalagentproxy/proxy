/// <reference types="bun" />

import {afterEach, describe, expect, test} from 'bun:test';
import {cleanup, render, screen} from '@testing-library/react';
import {createMemoryRouter, RouterProvider} from 'react-router';
import {AgentSide} from '@/components/agent-side';
import {AgentCollectionPage} from '@/pages/agent/agent-collection-page';
import {AgentRecordPage} from '@/pages/agent/agent-record-page';

afterEach(() => {
	cleanup();
});

const GMAIL_URL = 'https://mail.google.com/mail/?authuser=alex%40example.com#all/m1';

const EMAIL = {
	id: 'm1',
	values: {
		folder: 'Inbox',
		from: 'Sam Lee <sam@example.com>',
		subject: 'Q3 planning',
		date: '2026-10-01T09:00:00.000Z',
		status: 'Unread',
	},
	updatedAt: '2026-10-01T09:00:00.000Z',
	url: GMAIL_URL,
};

// The agent side at `path`, signed in with read access to a Google account and a mailbox over IMAP.
function renderAgentSide(path: string) {
	const router = createMemoryRouter(
		[
			{
				id: 'agent',
				loader: () => ({
					agent: {id: 'agent-1', providerId: 'instinct', name: 'Instinct'},
					connections: [
						{
							id: 'google-1',
							integrationId: 'google',
							account: 'alex@example.com',
							actions: ['readEmails'],
							tools: null,
							name: null,
						},
						{
							id: 'mail-1',
							integrationId: 'email',
							account: 'alex@fastmail.com',
							actions: ['read'],
							tools: null,
							name: null,
						},
					],
				}),
				element: <AgentSide />,
				children: [
					{
						path: '/agent/:connectionId/:collectionId',
						// A mailbox's email over IMAP has no address of its own.
						loader: ({params}) => ({
							kind: 'ok',
							value: {
								records:
									params.connectionId === 'mail-1'
										? [{...EMAIL, url: undefined}]
										: [EMAIL, {...EMAIL, id: 'm2', url: undefined}],
								nextPage: null,
							},
						}),
						element: <AgentCollectionPage />,
					},
					{
						path: '/agent/:connectionId/:collectionId/:recordId',
						loader: () => ({kind: 'ok', value: EMAIL}),
						element: <AgentRecordPage />,
					},
				],
			},
		],
		{initialEntries: [path]},
	);
	render(<RouterProvider router={router} />);
}

describe('links for the person', () => {
	test('a record opens in Gmail, its address written out, and the agent is told to give that', async () => {
		renderAgentSide('/agent/google-1/emails/m1');

		const link = await screen.findByRole('link', {name: 'Open in Gmail'});
		expect(link.getAttribute('href')).toBe(GMAIL_URL);
		expect(screen.getByText(`: ${GMAIL_URL}`, {exact: false})).toBeDefined();
		expect(
			screen.getByText(
				/^To show the person email, give them the links in Gmail, never the address of a page here/,
			),
		).toBeDefined();
	});

	test('a list links each record that has an address beside its row', async () => {
		renderAgentSide('/agent/google-1/emails');

		const links = await screen.findAllByRole('link', {name: 'Open in Gmail'});
		expect(links.map((link) => link.getAttribute('href'))).toEqual([GMAIL_URL]);
	});

	test('a mailbox over IMAP has no links, so the agent is told to name the email instead', async () => {
		renderAgentSide('/agent/mail-1/emails');

		expect(
			await screen.findByText(/Tell them which email you mean by its subject instead/),
		).toBeDefined();
		expect(screen.queryByRole('link', {name: /^Open/})).toBeNull();
	});
});
