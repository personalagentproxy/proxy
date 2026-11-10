/// <reference types="bun" />

import {afterEach, describe, expect, test} from 'bun:test';
import {act, cleanup, fireEvent, render, screen, waitFor} from '@testing-library/react';
import {DesktopUpdateNotice} from '@/components/desktop-update-notice';

afterEach(() => {
	cleanup();
	delete window.personalAgentProxyDesktop;
	window.sessionStorage.clear();
});

// The desktop app's window, with an update downloaded, or none.
function desktopWith(version: string | null, restart: () => void = () => {}) {
	window.personalAgentProxyDesktop = {
		updateReady: () => Promise.resolve(version),
		onUpdateReady: () => () => {},
		restart,
	};
}

describe('DesktopUpdateNotice', () => {
	test('offers a restart in the desktop app with an update downloaded', async () => {
		let restarts = 0;
		desktopWith('0.0.2', () => restarts++);
		render(<DesktopUpdateNotice />);

		await waitFor(() => expect(screen.getByRole('status')).toBeTruthy());
		fireEvent.click(screen.getByRole('button', {name: 'Restart'}));
		expect(restarts).toBe(1);
	});

	test('shows nothing in the desktop app without an update, nor in a browser', async () => {
		desktopWith(null);
		render(<DesktopUpdateNotice />);
		await act(async () => {});
		expect(screen.queryByRole('status')).toBeNull();

		cleanup();
		delete window.personalAgentProxyDesktop;
		render(<DesktopUpdateNotice />);
		await act(async () => {});
		expect(screen.queryByRole('status')).toBeNull();
	});

	test('dismissed, goes without restarting, and stays gone after a reload', async () => {
		let restarts = 0;
		desktopWith('0.0.2', () => restarts++);
		render(<DesktopUpdateNotice />);
		await waitFor(() => expect(screen.getByRole('status')).toBeTruthy());

		fireEvent.click(screen.getByRole('button', {name: 'Dismiss'}));
		expect(screen.queryByRole('status')).toBeNull();
		expect(restarts).toBe(0);

		cleanup();
		render(<DesktopUpdateNotice />);
		await act(async () => {});
		expect(screen.queryByRole('status')).toBeNull();
	});

	test('comes back for a newer update than the one dismissed', async () => {
		window.sessionStorage.setItem('proxy:dismissed-desktop-update', '0.0.2');
		desktopWith('0.0.3');
		render(<DesktopUpdateNotice />);
		await waitFor(() => expect(screen.getByRole('status')).toBeTruthy());
	});
});
