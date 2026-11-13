import {readdirSync} from 'node:fs';
import {join} from 'node:path';
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

describe('title bar layout', () => {
	test('covers the column seams behind the title bar', async () => {
		const css = await Bun.file(new URL('../index.css', import.meta.url)).text();

		expect(css).toMatch(
			/body:has\(\[data-page\]\)::before\s*{[^}]*background:\s*var\(--background\)/s,
		);
		expect(css).toMatch(
			/body:has\(\[data-slot='dialog-overlay'\]\[data-open\][\s\S]*visibility:\s*hidden/s,
		);
	});

	test('keeps modal backdrops above shell chrome', async () => {
		const styles = await Bun.file(new URL('../../../ui/src/styles.css', import.meta.url)).text();
		const dialog = await Bun.file(
			new URL('../../../ui/src/components/dialog.tsx', import.meta.url),
		).text();
		const webRoot = join(import.meta.dir, '../..');

		const shell = /--z-shell-chrome:\s*(\d+)/.exec(styles)?.[1];
		const modal = /--z-modal:\s*(\d+)/.exec(styles)?.[1];
		expect(shell).toBeDefined();
		expect(modal).toBeDefined();
		expect(Number(modal)).toBeGreaterThan(Number(shell));
		expect(dialog).toContain('z-modal');
		expect(dialog).toContain('z-[var(--z-modal)]');
		expect(styles).toMatch(/@utility\s+z-modal\s*\{[^}]*z-index:\s*var\(--z-modal\)/s);

		const build = Bun.spawn(['bun', 'run', 'build'], {
			cwd: webRoot,
			stdout: 'pipe',
			stderr: 'pipe',
		});
		expect((await build.exited) === 0).toBe(true);

		const cssFiles = readdirSync(join(webRoot, 'dist/assets')).filter((name) =>
			name.endsWith('.css'),
		);
		expect(cssFiles.length).toBeGreaterThan(0);
		const built = await Promise.all(
			cssFiles.map((name) => Bun.file(join(webRoot, 'dist/assets', name)).text()),
		);
		expect(built.some((css) => /\.z-modal\{[^}]*z-index:\s*var\(--z-modal\)/.test(css))).toBe(true);
	}, 120_000);
});
