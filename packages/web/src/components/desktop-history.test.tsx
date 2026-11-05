/// <reference types="bun" />

import {afterEach, beforeEach, describe, expect, test} from 'bun:test';
import {act, cleanup, fireEvent, render, screen} from '@testing-library/react';
import {createMemoryRouter, Outlet, RouterProvider} from 'react-router';
import {TooltipProvider} from '@proxy/ui/components/tooltip';
import {DesktopHistory} from '@/components/desktop-history';

// The window's history as the Navigation API tells it, which happy-dom has none of.
class FakeNavigation {
	canGoBack = false;
	canGoForward = false;
	listeners = new Set<() => void>();

	addEventListener(_type: 'currententrychange', listener: () => void) {
		this.listeners.add(listener);
	}

	removeEventListener(_type: 'currententrychange', listener: () => void) {
		this.listeners.delete(listener);
	}

	set(next: {canGoBack: boolean; canGoForward: boolean}) {
		this.canGoBack = next.canGoBack;
		this.canGoForward = next.canGoForward;
		for (const listener of this.listeners) {
			listener();
		}
	}
}

let history: FakeNavigation;

beforeEach(() => {
	history = new FakeNavigation();
	Object.assign(globalThis, {navigation: history});
});

afterEach(() => {
	cleanup();
	Reflect.deleteProperty(globalThis, 'navigation');
});

function renderAt(entries: string[], index: number) {
	const router = createMemoryRouter(
		[
			{
				element: (
					<>
						<Outlet />
						<DesktopHistory />
					</>
				),
				children: [
					{path: '/connections', element: <p>Connections</p>},
					{path: '/connections/c1', element: <p>Gmail</p>},
				],
			},
		],
		{initialEntries: entries, initialIndex: index},
	);
	render(
		<TooltipProvider>
			<RouterProvider router={router} />
		</TooltipProvider>,
	);
}

function button(name: string): HTMLElement {
	return screen.getByRole('button', {name});
}

function isOff(name: string): boolean {
	return button(name).hasAttribute('disabled');
}

describe('DesktopHistory', () => {
	test('is off where the history has nowhere to go, and follows it as it changes', () => {
		renderAt(['/connections'], 0);

		expect(isOff('Back')).toBe(true);
		expect(isOff('Forward')).toBe(true);

		act(() => history.set({canGoBack: true, canGoForward: false}));

		expect(isOff('Back')).toBe(false);
		expect(isOff('Forward')).toBe(true);
	});

	test('goes back and forward', async () => {
		history.set({canGoBack: true, canGoForward: true});
		renderAt(['/connections', '/connections/c1'], 1);
		expect(screen.getByText('Gmail')).toBeTruthy();

		fireEvent.click(button('Back'));
		expect(await screen.findByText('Connections')).toBeTruthy();

		fireEvent.click(button('Forward'));
		expect(await screen.findByText('Gmail')).toBeTruthy();
	});

	test('goes back with ⌘[ and forward with ⌘]', async () => {
		renderAt(['/connections', '/connections/c1'], 1);

		fireEvent.keyDown(window, {key: '[', metaKey: true});
		expect(await screen.findByText('Connections')).toBeTruthy();

		fireEvent.keyDown(window, {key: ']', metaKey: true});
		expect(await screen.findByText('Gmail')).toBeTruthy();
	});

	test("goes back and forward with the mouse's side buttons", async () => {
		renderAt(['/connections', '/connections/c1'], 1);

		fireEvent.mouseUp(window, {button: 3});
		expect(await screen.findByText('Connections')).toBeTruthy();

		fireEvent.mouseUp(window, {button: 4});
		expect(await screen.findByText('Gmail')).toBeTruthy();
	});
});
