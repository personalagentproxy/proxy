/// <reference types="bun" />

import {afterEach, describe, expect, test} from 'bun:test';
import {act, cleanup, fireEvent, render, screen} from '@testing-library/react';
import {DesktopUpdateCheck} from '@/components/desktop-update-check';
import type {DesktopUpdateStatus} from '@/lib/desktop';

afterEach(() => {
	cleanup();
	delete window.personalAgentProxyDesktop;
});

// A desktop app that can be asked to look, at `status`, with what it was asked and a way to tell
// the page where the update stands next.
function desktopAt(status: DesktopUpdateStatus) {
	const asked = {checks: 0, restarts: 0};
	const listeners = new Set<(status: DesktopUpdateStatus) => void>();
	window.personalAgentProxyDesktop = {
		updateReady: async () => null,
		onUpdateReady: () => () => undefined,
		restart: () => {
			asked.restarts++;
		},
		updateStatus: async () => status,
		onUpdateStatus: (listener) => {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		checkForUpdates: () => {
			asked.checks++;
		},
	};
	const tell = (next: DesktopUpdateStatus) => {
		act(() => {
			for (const listener of listeners) {
				listener(next);
			}
		});
	};
	return {asked, tell};
}

describe('DesktopUpdateCheck', () => {
	test('looks when asked, and says where that stands through the download to the restart', async () => {
		const {asked, tell} = desktopAt({state: 'idle'});
		render(<DesktopUpdateCheck />);

		fireEvent.click(await screen.findByRole('button', {name: 'Check for updates'}));
		expect(asked.checks).toBe(1);

		tell({state: 'checking'});
		expect(screen.getByText('Checking for updates…')).toBeDefined();
		expect(screen.getByRole('button', {name: 'Check for updates'}).hasAttribute('disabled')).toBe(
			true,
		);

		tell({state: 'downloading', version: '0.0.6', percent: 42.7});
		expect(screen.getByText('Downloading version 0.0.6… 42%')).toBeDefined();

		tell({state: 'ready', version: '0.0.6'});
		expect(screen.getByText('Version 0.0.6 is downloaded.')).toBeDefined();
		fireEvent.click(screen.getByRole('button', {name: 'Restart to update'}));
		expect(asked.restarts).toBe(1);
	});

	test('says when there is nothing newer, and when the look failed, and can look again', async () => {
		const {asked, tell} = desktopAt({state: 'latest'});
		render(<DesktopUpdateCheck />);
		expect(await screen.findByText('You have the latest version.')).toBeDefined();

		tell({state: 'failed'});
		const failed = screen.getByText('Could not check for updates. Try again.');
		expect(failed.className).toContain('text-destructive');
		fireEvent.click(screen.getByRole('button', {name: 'Check for updates'}));
		expect(asked.checks).toBe(1);
	});

	test('in an app from before the check, says how to have it look, and offers the restart once it has one', async () => {
		let ready: ((version: string) => void) | null = null;
		window.personalAgentProxyDesktop = {
			updateReady: async () => null,
			onUpdateReady: (listener) => {
				ready = listener;
				return () => undefined;
			},
			restart: () => undefined,
		};
		render(<DesktopUpdateCheck />);
		expect(await screen.findByText(/Quit and reopen the app to update it/)).toBeDefined();
		expect(screen.queryByRole('button', {name: 'Check for updates'})).toBeNull();

		act(() => ready?.('0.0.5'));
		expect(screen.getByText('Version 0.0.5 is downloaded.')).toBeDefined();
		expect(screen.getByRole('button', {name: 'Restart to update'})).toBeDefined();
	});

	test('shows nothing in a browser', async () => {
		render(<DesktopUpdateCheck />);
		await act(async () => {});
		expect(document.body.textContent).toBe('');
	});
});
