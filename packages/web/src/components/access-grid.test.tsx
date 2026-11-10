/// <reference types="bun" />

import type {AgentLogin} from '@proxy/contracts/agents';
import type {Action} from '@proxy/integrations';
import {afterEach, describe, expect, mock, test} from 'bun:test';
import {cleanup, fireEvent, render, screen, waitFor, within} from '@testing-library/react';
import {createMemoryRouter, RouterProvider} from 'react-router';
import {AccessGrid, type GridAgent} from '@/components/access-grid';

afterEach(() => {
	cleanup();
});

const actions: Action[] = [
	{id: 'read', label: 'Read', description: 'List and open emails', risk: 'low'},
	{
		id: 'archive',
		label: 'Archive',
		description: 'Move emails out of the inbox',
		risk: 'medium',
		requires: 'read',
	},
	{id: 'send', label: 'Send', description: 'Send email', risk: 'high'},
];

function agent(id: string, name: string): AgentLogin {
	return {
		id,
		providerId: 'claude',
		name,
		username: id,
		shared: false,
		createdById: 'user-1',
		createdBy: 'Alex',
		createdAt: '2026-10-01T00:00:00.000Z',
		lastActiveAt: null,
		revokedAt: null,
		grants: [],
	};
}

// Claude, which may send though the default says no, and Scout, which follows every default.
const claude: GridAgent = {agent: agent('agent-1', 'Claude'), own: {send: true}, mayChange: true};
const scout: GridAgent = {agent: agent('agent-2', 'Scout'), own: {}, mayChange: true};

function renderGrid(props: Partial<Parameters<typeof AccessGrid>[0]> = {}) {
	const onChangeDefaults = mock(async (_actions: Record<string, boolean>) => {});
	const onChangeAgent = mock(
		async (_agentId: string, _actionId: string, _allowed: boolean | null) => {},
	);
	const router = createMemoryRouter(
		[
			{
				path: '/:org/connections/:id',
				element: (
					<AccessGrid
						actions={actions}
						defaults={['read']}
						agents={[claude, scout]}
						unavailable={[]}
						signInNeeded={false}
						mayChangeDefaults
						onChangeDefaults={onChangeDefaults}
						onChangeAgent={onChangeAgent}
						{...props}
					/>
				),
			},
		],
		{initialEntries: ['/acme/connections/conn-1']},
	);
	render(<RouterProvider router={router} />);
	return {onChangeDefaults, onChangeAgent};
}

const box = (name: string) => screen.getByRole('checkbox', {name});
const ticked = (name: string) => box(name).getAttribute('aria-checked');

describe('AccessGrid', () => {
	test('is an action a row and a column each for the default and every agent, an agent following the default unless it has a setting of its own', () => {
		renderGrid();

		expect(screen.getAllByRole('columnheader').map((heading) => heading.textContent)).toEqual([
			'Action',
			'Default',
			'Claude',
			'Scout',
		]);
		expect(screen.getAllByRole('rowheader').map((heading) => heading.textContent)).toEqual([
			'ReadList and open emails',
			'ArchiveMove emails out of the inbox',
			'SendHigh riskSend email',
		]);
		expect(['Read by default', 'Read for Claude', 'Read for Scout'].map(ticked)).toEqual([
			'true',
			'true',
			'true',
		]);
		expect(
			['Send by default', 'Send for Claude, its own setting', 'Send for Scout'].map(ticked),
		).toEqual(['false', 'true', 'false']);
		expect(screen.getByRole('link', {name: 'Claude'}).getAttribute('href')).toBe(
			'/acme/agents/agent-1',
		);
	});

	test('a box under Default changes the default', async () => {
		const {onChangeDefaults, onChangeAgent} = renderGrid();

		fireEvent.click(box('Archive by default'));

		await waitFor(() => expect(onChangeDefaults).toHaveBeenCalledWith({archive: true}));
		expect(onChangeAgent).not.toHaveBeenCalled();
	});

	test('a box under an agent gives it a setting of its own, and ticking it back to what the default says drops the setting', async () => {
		const {onChangeAgent, onChangeDefaults} = renderGrid();

		fireEvent.click(box('Read for Scout'));
		await waitFor(() => expect(onChangeAgent).toHaveBeenCalledWith('agent-2', 'read', false));

		fireEvent.click(box('Send for Claude, its own setting'));
		await waitFor(() => expect(onChangeAgent).toHaveBeenCalledWith('agent-1', 'send', null));
		expect(onChangeDefaults).not.toHaveBeenCalled();
	});

	test('an agent’s own setting says on hover what it does to the default; a box that follows it says nothing', async () => {
		renderGrid({agents: [{...claude, own: {send: true, read: false}}, scout]});

		fireEvent.focus(box('Send for Claude, its own setting'));
		expect(await screen.findByText('Overwrites default to on')).toBeDefined();
		fireEvent.blur(box('Send for Claude, its own setting'));

		fireEvent.focus(box('Read for Claude, its own setting'));
		expect(await screen.findByText('Overwrites default to off')).toBeDefined();
		expect(box('Read for Scout').closest('[data-own]')).toBeNull();
	});

	test('an action the sign-in didn’t cover is off and disabled for everyone, whatever is set', () => {
		renderGrid({unavailable: ['send']});

		expect(screen.getByText(/Not allowed at sign-in/)).toBeDefined();
		for (const name of ['Send by default', 'Send for Claude, its own setting', 'Send for Scout']) {
			expect(ticked(name)).toBe('false');
			expect(box(name).hasAttribute('data-disabled')).toBe(true);
		}
	});

	test('someone who may change neither the defaults nor an agent sees the grid and changes nothing', () => {
		renderGrid({mayChangeDefaults: false, agents: [{...claude, mayChange: false}, scout]});

		expect(box('Read by default').hasAttribute('data-disabled')).toBe(true);
		expect(box('Read for Claude').hasAttribute('data-disabled')).toBe(true);
		expect(box('Read for Scout').hasAttribute('data-disabled')).toBe(false);
	});

	test('with no agent reaching the connection, there is the default alone, and it says so', () => {
		renderGrid({agents: []});

		expect(screen.getAllByRole('columnheader').map((heading) => heading.textContent)).toEqual([
			'Action',
			'Default',
		]);
		expect(screen.getByText('No agent reaches this connection yet.')).toBeDefined();
	});

	test('under a heading of the page’s own, ungrouped actions have no heading row, and groups keep theirs', () => {
		renderGrid({headed: true});
		expect(screen.queryByRole('columnheader')).toBeNull();
		expect(screen.getAllByRole('rowheader')).toHaveLength(3);
		cleanup();

		renderGrid({headed: true, actions: [{...actions[0]!, group: 'Gmail'}]});
		expect(screen.getAllByRole('columnheader').map((heading) => heading.textContent)).toEqual([
			'Gmail',
			'Default',
			'Claude',
			'Scout',
		]);
	});

	test('actions the integration groups are each a part under its group’s name, with the columns named again', () => {
		renderGrid({
			actions: [
				{...actions[0]!, group: 'Gmail'},
				{...actions[2]!, group: 'Gmail'},
				{
					id: 'readEvents',
					label: 'Read events',
					description: 'List events',
					risk: 'low',
					group: 'Calendar',
				},
			],
		});

		expect(screen.getAllByRole('columnheader').map((heading) => heading.textContent)).toEqual([
			'Gmail',
			'Default',
			'Claude',
			'Scout',
			'Calendar',
			'Default',
			'Claude',
			'Scout',
		]);
		const parts = screen.getAllByRole('rowgroup');
		expect(
			parts.map((part) =>
				within(part)
					.getAllByRole('rowheader')
					.map((heading) => heading.textContent),
			),
		).toEqual([
			['ReadList and open emails', 'SendHigh riskSend email'],
			['Read eventsList events'],
		]);
	});
});
