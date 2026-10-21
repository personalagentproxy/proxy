/// <reference types="bun" />

import {afterEach, describe, expect, test} from 'bun:test';
import {cleanup, fireEvent, render, screen, waitFor, within} from '@testing-library/react';
import {createMemoryRouter, RouterProvider} from 'react-router';
import {TooltipProvider} from '@proxy/ui/components/tooltip';
import {ThemeProvider} from '@proxy/ui/components/theme-provider';
import {HumanSide} from '@/components/human-side';
import type {Connection} from '@/lib/types';
import {ConnectionsPage} from '@/pages/connections-page';

afterEach(() => {
	cleanup();
});

function connection(
	id: string,
	integrationId: string,
	account: string,
	name: string | null = null,
): Connection {
	return {
		id,
		integrationId,
		account,
		defaults: [],
		tools: null,
		name,
		unavailable: [],
		signInNeeded: false,
	};
}

function renderConnectionsPage(connections: Connection[]) {
	const router = createMemoryRouter(
		[
			{
				id: 'human',
				loader: () => ({
					user: {id: 'user-1', email: 'person@example.com', name: null, image: null},
					org: {id: 'org-1', name: 'Workspace', role: 'owner'},
					onboarded: true,
					experiments: [],
					orgs: [
						{id: 'org-1', name: 'Workspace', role: 'owner', memberCount: 1, invitationCount: 0},
					],
				}),
				element: <HumanSide />,
				children: [
					{
						path: '/connections',
						loader: () => ({connections, agents: []}),
						element: <ConnectionsPage />,
					},
				],
			},
		],
		{initialEntries: ['/connections']},
	);

	return render(
		<ThemeProvider>
			<TooltipProvider>
				<RouterProvider router={router} />
			</TooltipProvider>
		</ThemeProvider>,
	);
}

describe('ConnectionsPage', () => {
	test('shows how many connections use a service and summarizes its other accounts', async () => {
		renderConnectionsPage([
			connection('email-1', 'email', 'alex@example.com'),
			connection('notion-1', 'notion', 'Acme'),
			connection('email-2', 'email', 'alex@home.example'),
			connection('email-3', 'email', 'receipts@icloud.example'),
		]);

		const emailRows = await screen.findAllByRole('link', {name: /Email/});
		expect(emailRows).toHaveLength(3);
		const accounts = ['alex@example.com', 'alex@home.example', 'receipts@icloud.example'];
		for (const [index, row] of emailRows.entries()) {
			const account = accounts[index];
			if (!account) {
				throw new Error('An Email row rendered without an account');
			}

			expect(within(row).getByText('3 connections')).toBeDefined();
			expect(within(row).getByText('+2')).toBeDefined();
			expect(within(row).getAllByText(account)).toHaveLength(1);
			const item = row.closest('li');
			if (!item) {
				throw new Error('An Email row rendered outside a list item');
			}

			fireEvent.mouseEnter(item);
			const tooltip = await screen.findByRole('tooltip');
			for (const relatedAccount of accounts) {
				expect(within(tooltip).getByText(relatedAccount)).toBeDefined();
			}
			fireEvent.keyDown(document, {key: 'Escape'});
			await waitFor(() => expect(screen.queryByRole('tooltip')).toBeNull());
		}
		expect(screen.queryByText('1 connection')).toBeNull();

		const focusedRow = emailRows[0];
		if (!focusedRow) {
			throw new Error('The first Email row did not render');
		}
		const focusedItem = focusedRow.closest('li');
		if (!focusedItem) {
			throw new Error('The first Email row rendered outside a list item');
		}

		fireEvent.focus(focusedRow);
		await screen.findByRole('tooltip');
		fireEvent.mouseEnter(focusedItem);
		fireEvent.mouseLeave(focusedItem);
		expect(screen.getByRole('tooltip')).toBeDefined();
		fireEvent.blur(focusedRow);
		await waitFor(() => expect(screen.queryByRole('tooltip')).toBeNull());
	});

	test('leaves a service with one connection as a single account without a tooltip', async () => {
		renderConnectionsPage([connection('notion-1', 'notion', 'Acme')]);

		const row = await screen.findByRole('link', {name: /Notion/});
		expect(within(row).getByText('Acme')).toBeDefined();
		expect(within(row).queryByText(/^\+/)).toBeNull();
		expect(row.hasAttribute('data-base-ui-tooltip-trigger')).toBeFalse();
	});

	test('keeps custom MCP servers separate even though they share an integration id', async () => {
		renderConnectionsPage([
			connection('mcp-1', 'mcp', 'docs.example/mcp', 'Docs'),
			connection('mcp-2', 'mcp', 'crm.example/mcp', 'CRM'),
		]);

		const docs = await screen.findByRole('link', {name: /Docs/});
		const crm = await screen.findByRole('link', {name: /CRM/});
		for (const row of [docs, crm]) {
			expect(within(row).queryByText(/connections/)).toBeNull();
			expect(within(row).queryByText(/^\+/)).toBeNull();
			expect(row.hasAttribute('data-base-ui-tooltip-trigger')).toBeFalse();
		}
	});
});
