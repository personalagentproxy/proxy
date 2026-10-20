/// <reference types="bun" />

import {afterEach, describe, expect, test} from 'bun:test';
import {cleanup, render, screen} from '@testing-library/react';
import {createMemoryRouter, Outlet, RouterProvider} from 'react-router';
import {AgentHomePage} from '@/pages/agent/agent-home-page';
import {AgentTaskPage} from '@/pages/agent/agent-task-page';

afterEach(() => {
	cleanup();
});

const TASK = {
	task: 'task-1',
	title: 'Look around',
	goal: 'See what is connected',
	startedAt: '2026-10-16T09:00:00.000Z',
	finishedAt: null,
};

function renderAgentSide(path: string) {
	const router = createMemoryRouter(
		[
			{
				id: 'agent',
				loader: () => ({
					agent: {id: 'agent-1', providerId: 'claude', name: 'Claude'},
					connections: [],
				}),
				element: <Outlet />,
				children: [
					{path: '/agent', loader: () => ({tasks: [TASK]}), element: <AgentTaskPage />},
					{
						id: 'agent-task',
						path: '/agent/:taskId',
						loader: () => TASK,
						element: <Outlet />,
						children: [{index: true, element: <AgentHomePage />}],
					},
				],
			},
		],
		{initialEntries: [path]},
	);
	render(<RouterProvider router={router} />);
}

describe('AgentHomePage', () => {
	test('directs a login without access to the Connections page, naming the task in its address', async () => {
		renderAgentSide('/agent/task-1');

		expect(
			await screen.findByText(
				'No connections are available to this login yet. Ask the person who set it up to add a service on the Connections page, or give this login access to one already connected.',
			),
		).toBeDefined();
		expect(screen.getByRole('link', {name: 'Look around'}).getAttribute('href')).toBe('/agent');
		expect(screen.getByRole('button', {name: 'Finish task'})).toBeDefined();
	});
});

describe('AgentTaskPage', () => {
	test('lists the tasks under way, each opening its own pages, beside starting another', async () => {
		renderAgentSide('/agent');

		expect(await screen.findByRole('heading', {name: 'Start another task'})).toBeDefined();
		expect(screen.getByRole('link', {name: /Look around/}).getAttribute('href')).toBe(
			'/agent/task-1',
		);
		expect(screen.queryByRole('button', {name: 'Finish task'})).toBeNull();
	});

	test('says which task was refused when the agent is sent back to its tasks', async () => {
		renderAgentSide('/agent?refused=task-9');

		expect(
			await screen.findByText(/^Task task-9 can’t be worked on anymore: it is finished/),
		).toBeDefined();
	});
});
