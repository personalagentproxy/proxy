/// <reference types="bun" />

import {afterEach, describe, expect, test} from 'bun:test';
import {cleanup, render, screen} from '@testing-library/react';
import {createMemoryRouter, RouterProvider} from 'react-router';
import {DesktopAuthPage} from '@/pages/desktop-auth-page';

afterEach(() => {
	cleanup();
});

describe('DesktopAuthPage', () => {
	test('offers the app’s link with the code, for a browser that asks before opening it', async () => {
		const router = createMemoryRouter(
			[
				{
					path: '/desktop-auth',
					loader: () => ({link: 'personalagentproxy://auth-callback?code=code-1'}),
					element: <DesktopAuthPage />,
				},
			],
			{initialEntries: ['/desktop-auth?challenge=x']},
		);
		render(<RouterProvider router={router} />);

		// Base UI renders the link as a button, in role as in looks.
		const open = await screen.findByRole('button', {name: 'Open Personal Agent Proxy'});
		expect(open.getAttribute('href')).toBe('personalagentproxy://auth-callback?code=code-1');
		expect(screen.getByText('Opening Personal Agent Proxy…')).toBeTruthy();
	});
});
