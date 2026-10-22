/// <reference types="bun" />

import {afterEach, describe, expect, test} from 'bun:test';
import {cleanup, fireEvent, render, screen, within} from '@testing-library/react';
import {createMemoryRouter, RouterProvider} from 'react-router';
import {TooltipProvider} from '@proxy/ui/components/tooltip';
import {AuditList} from '@/components/audit-list';
import type {ActivityTask, AgentLogin, AuditEntry, Connection} from '@/lib/types';

afterEach(() => {
	cleanup();
});

const agent: AgentLogin = {
	id: 'agent-1',
	providerId: 'claude',
	name: 'Claude',
	username: 'claude-1',
	shared: false,
	createdById: 'user-1',
	createdBy: null,
	createdAt: '2026-10-01T00:00:00.000Z',
	lastActiveAt: null,
	revokedAt: null,
	grants: [],
};

const connection: Connection = {
	id: 'connection-1',
	integrationId: 'email',
	orgId: 'org-1',
	shared: false,
	connectedById: 'user-1',
	connectedBy: null,
	account: 'me@example.com',
	defaults: [],
	tools: null,
	name: null,
	unavailable: [],
	signInNeeded: false,
};

const task: ActivityTask = {
	id: 'task-1',
	agentId: agent.id,
	title: 'Triage inbox',
	goal: 'Archive the newsletters',
	via: 'mcp',
	startedAt: '2026-10-14T21:00:00.000Z',
	finishedAt: null,
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
	taskId: task.id,
};

describe('AuditList', () => {
	test('opens an entry in full from its row', async () => {
		const router = createMemoryRouter(
			[
				{
					path: '/:org/activity',
					element: (
						<TooltipProvider>
							<AuditList
								entries={[entry]}
								agents={[agent]}
								connections={[connection]}
								tasks={[task]}
							/>
						</TooltipProvider>
					),
				},
			],
			{initialEntries: ['/org-1/activity']},
		);
		render(<RouterProvider router={router} />);

		const row = await screen.findByRole('button', {name: /Tried to archive email/});
		expect(row.textContent).toContain('· for Triage inbox');
		fireEvent.click(row);

		const dialog = await screen.findByRole('dialog');
		expect(within(dialog).getByText('Denied')).toBeDefined();
		expect(within(dialog).getByRole('link', {name: 'Triage inbox'}).getAttribute('href')).toBe(
			'/org-1/activity?task=task-1',
		);
		expect(within(dialog).getByText('Archive the newsletters')).toBeDefined();
		expect(within(dialog).getByRole('link', {name: 'Claude'}).getAttribute('href')).toBe(
			'/org-1/agents/agent-1',
		);
		expect(within(dialog).getByText('me@example.com')).toBeDefined();
		expect(within(dialog).getByText('Weekly digest')).toBeDefined();
		expect(within(dialog).getByText('Archive')).toBeDefined();
		expect(within(dialog).getByText('MCP')).toBeDefined();
	});
});
