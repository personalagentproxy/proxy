/// <reference types="bun" />

import {afterEach, describe, expect, test} from 'bun:test';
import {cleanup, render, screen} from '@testing-library/react';
import {createMemoryRouter, RouterProvider} from 'react-router';
import {DesktopReturnPage} from '@/pages/desktop-return-page';

afterEach(() => {
	cleanup();
});

function renderAt(search: string) {
	const router = createMemoryRouter([{path: '/desktop-return', element: <DesktopReturnPage />}], {
		initialEntries: [`/desktop-return${search}`],
	});
	render(<RouterProvider router={router} />);
}

describe('DesktopReturnPage', () => {
	test('offers the app’s link to the page the work ended on', async () => {
		renderAt('?path=%2Facme%2Fconnections%2Fconn-1%3Fadded');

		// Base UI renders the link as a button, in role as in looks.
		const open = await screen.findByRole('button', {name: 'Open Personal Agent Proxy'});
		expect(open.getAttribute('href')).toBe(
			'personalagentproxy://open?path=%2Facme%2Fconnections%2Fconn-1%3Fadded',
		);
	});

	test('opens the app’s root for a path that is not one in the app', async () => {
		renderAt('?path=https%3A%2F%2Fevil.example%2F');

		const open = await screen.findByRole('button', {name: 'Open Personal Agent Proxy'});
		expect(open.getAttribute('href')).toBe('personalagentproxy://open?path=%2F');
	});
});
