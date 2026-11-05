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

describe('hidden desktop title bar layout', () => {
	test('offsets only page-scrolling headers below the title bar', async () => {
		const css = await Bun.file(new URL('../index.css', import.meta.url)).text();

		expect(css).toMatch(
			/\[data-desktop-page\]\s*>\s*header\.sticky\s*{[^}]*top:\s*var\(--desktop-title-bar-height\)/s,
		);
	});

	test('covers the column seams behind the title bar', async () => {
		const css = await Bun.file(new URL('../index.css', import.meta.url)).text();

		expect(css).toMatch(/body::before\s*{[^}]*background:\s*var\(--background\)/s);
	});
});
