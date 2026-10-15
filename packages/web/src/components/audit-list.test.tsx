/// <reference types="bun" />

import {afterEach, describe, expect, test} from 'bun:test';
import {cleanup, fireEvent, render, screen, within} from '@testing-library/react';
import {createMemoryRouter, RouterProvider} from 'react-router';
import {TooltipProvider} from '@proxy/ui/components/tooltip';
import {AuditList} from '@/components/audit-list';
import type {AgentLogin, AuditEntry, Connection} from '@/lib/types';

afterEach(() => {
	cleanup();
});

const agent: AgentLogin = {
	id: 'agent-1',
	providerId: 'claude',
	name: 'Claude',
	username: 'claude-1',
	createdAt: '2026-10-01T00:00:00.000Z',
	lastActiveAt: null,
	revokedAt: null,
	grants: [],
};

const connection: Connection = {
	id: 'connection-1',
	integrationId: 'email',
	account: 'me@example.com',
	defaults: [],
	tools: null,
	name: null,
	unavailable: [],
};

const entry: AuditEntry = {
	id: 'entry-1',
	at: '2026-10-14T21:15:32.000Z',
	agentId: agent.id,
	connectionId: connection.id,
	collectionId: 'emails',
	action: 'archive',
	recordTitle: 'Weekly digest',
	query: null,
	outcome: 'denied',
	via: 'mcp',
};

describe('AuditList', () => {
	test('opens an entry in full from its row', async () => {
		const router = createMemoryRouter(
			[
				{
					path: '/activity',
					element: (
						<TooltipProvider>
							<AuditList entries={[entry]} agents={[agent]} connections={[connection]} />
						</TooltipProvider>
					),
				},
			],
			{initialEntries: ['/activity']},
		);
		render(<RouterProvider router={router} />);

		fireEvent.click(await screen.findByRole('button', {name: /Tried to archive email/}));

		const dialog = await screen.findByRole('dialog');
		expect(within(dialog).getByText('Denied')).toBeDefined();
		expect(within(dialog).getByRole('link', {name: 'Claude'}).getAttribute('href')).toBe(
			'/agents/agent-1',
		);
		expect(within(dialog).getByText('me@example.com')).toBeDefined();
		expect(within(dialog).getByText('Weekly digest')).toBeDefined();
		expect(within(dialog).getByText('Archive')).toBeDefined();
		expect(within(dialog).getByText('MCP')).toBeDefined();
	});
});
