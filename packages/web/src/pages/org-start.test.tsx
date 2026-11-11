/// <reference types="bun" />

import type {Experiment} from '@proxy/utils';
import {afterEach, describe, expect, test} from 'bun:test';
import {cleanup, render, screen} from '@testing-library/react';
import {createMemoryRouter, RouterProvider, useLocation} from 'react-router';
import {OrgStart} from '@/pages/org-start';
import {testHuman, testOrg} from '@/test-org';

afterEach(() => {
	cleanup();
});

// A page that says where the app is, in place of the one the organization opens on.
function Where() {
	return <p data-testid="where">{useLocation().pathname}</p>;
}

function renderOrg(experiments: Experiment[]) {
	const router = createMemoryRouter(
		[
			{
				id: 'human',
				loader: () => testHuman({...testOrg, experiments}),
				children: [
					{path: '/:org', element: <OrgStart />},
					{path: '/:org/*', element: <Where />},
				],
			},
		],
		{initialEntries: ['/acme']},
	);
	render(<RouterProvider router={router} />);
}

describe('OrgStart', () => {
	test('opens Chat in an organization that has it', async () => {
		renderOrg(['harness']);
		expect((await screen.findByTestId('where')).textContent).toBe('/acme/chat');
	});

	test('opens Connections in one without it', async () => {
		renderOrg([]);
		expect((await screen.findByTestId('where')).textContent).toBe('/acme/connections');
	});
});
