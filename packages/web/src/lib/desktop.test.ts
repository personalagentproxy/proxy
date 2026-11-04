import {afterEach, describe, expect, test} from 'bun:test';

import {hasHiddenDesktopTitleBar, type DesktopBridge} from '@/lib/desktop';

function bridge(titleBarHidden?: boolean): DesktopBridge {
	return {
		...(titleBarHidden === undefined ? {} : {titleBarHidden}),
		updateReady: async () => null,
		onUpdateReady: () => () => undefined,
		restart: () => undefined,
	};
}

describe('hasHiddenDesktopTitleBar', () => {
	afterEach(() => {
		delete window.personalAgentProxyDesktop;
	});

	test('is false unless the desktop shell explicitly hides its title bar', () => {
		expect(hasHiddenDesktopTitleBar()).toBe(false);
		window.personalAgentProxyDesktop = bridge();
		expect(hasHiddenDesktopTitleBar()).toBe(false);
		window.personalAgentProxyDesktop = bridge(false);
		expect(hasHiddenDesktopTitleBar()).toBe(false);
	});

	test('is true only when the desktop shell says its title bar is hidden', () => {
		window.personalAgentProxyDesktop = bridge(true);

		expect(hasHiddenDesktopTitleBar()).toBe(true);
	});
});
