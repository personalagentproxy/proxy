/// <reference types="bun" />

import {afterEach, beforeEach, describe, expect, test} from 'bun:test';
import {act, cleanup, fireEvent, render, screen, waitFor} from '@testing-library/react';
import {SidebarProvider} from '@proxy/ui/components/sidebar';
import {TooltipProvider} from '@proxy/ui/components/tooltip';
import {ThemeMenu} from '@/components/theme-menu';
import {ThemeProvider} from '@proxy/ui/components/theme-provider';
import {
	storeTheme,
	storedTheme,
	THEME_STORAGE_KEY,
	useTheme,
	type Theme,
} from '@proxy/ui/lib/theme';
import {testWindow} from '@/test-dom';

function ThemeProbe({nextTheme}: {nextTheme?: Theme}) {
	const {theme, setTheme} = useTheme();

	return (
		<>
			<span data-testid="theme">{theme}</span>
			{nextTheme && <button onClick={() => setTheme(nextTheme)}>Use {nextTheme}</button>}
		</>
	);
}

function renderTheme(children: React.ReactNode) {
	return render(<ThemeProvider>{children}</ThemeProvider>);
}

beforeEach(() => {
	document.documentElement.className = '';
	document.documentElement.dataset.themeStorageKey = THEME_STORAGE_KEY;
	localStorage.clear();
	testWindow.happyDOM.settings.device.prefersColorScheme = 'light';
});

afterEach(() => {
	cleanup();
});

describe('theme storage', () => {
	test('accepts only the three supported theme values', () => {
		localStorage.setItem(THEME_STORAGE_KEY, 'dark');
		expect(storedTheme(localStorage, THEME_STORAGE_KEY)).toBe('dark');

		localStorage.setItem(THEME_STORAGE_KEY, 'sepia');
		expect(storedTheme(localStorage, THEME_STORAGE_KEY)).toBeNull();
	});

	test('falls back safely when browser storage is unavailable', () => {
		const unavailableStorage = {
			getItem: () => {
				throw new Error('Storage unavailable');
			},
			setItem: () => {
				throw new Error('Storage unavailable');
			},
		};

		expect(storedTheme(unavailableStorage, THEME_STORAGE_KEY)).toBeNull();
		expect(() => storeTheme(unavailableStorage, THEME_STORAGE_KEY, 'dark')).not.toThrow();
	});
});

describe('ThemeProvider', () => {
	test('restores a saved theme and applies it to the document', async () => {
		localStorage.setItem(THEME_STORAGE_KEY, 'dark');
		renderTheme(<ThemeProbe />);

		expect(screen.getByTestId('theme').textContent).toBe('dark');
		await waitFor(() => expect(document.documentElement.classList.contains('dark')).toBe(true));
	});

	test('uses and follows the system theme when there is no saved preference', async () => {
		renderTheme(<ThemeProbe />);

		expect(screen.getByTestId('theme').textContent).toBe('system');
		await waitFor(() => expect(document.documentElement.classList.contains('light')).toBe(true));

		testWindow.happyDOM.settings.device.prefersColorScheme = 'dark';
		window.dispatchEvent(new Event('resize'));

		await waitFor(() => expect(document.documentElement.classList.contains('dark')).toBe(true));
	});

	test('persists an explicit theme even when storage cannot be written', async () => {
		const originalSetItem = localStorage.setItem;
		localStorage.setItem = () => {
			throw new Error('Storage unavailable');
		};

		try {
			renderTheme(<ThemeProbe nextTheme="dark" />);
			fireEvent.click(screen.getByRole('button', {name: 'Use dark'}));

			expect(screen.getByTestId('theme').textContent).toBe('dark');
			await waitFor(() => expect(document.documentElement.classList.contains('dark')).toBe(true));
		} finally {
			localStorage.setItem = originalSetItem;
		}
	});

	test('keeps working when access to browser storage is blocked', async () => {
		const storageDescriptor = Object.getOwnPropertyDescriptor(window, 'localStorage');
		Object.defineProperty(window, 'localStorage', {
			configurable: true,
			get: () => {
				throw new DOMException('Storage unavailable', 'SecurityError');
			},
		});

		try {
			renderTheme(<ThemeProbe nextTheme="dark" />);

			expect(screen.getByTestId('theme').textContent).toBe('system');
			fireEvent.click(screen.getByRole('button', {name: 'Use dark'}));
			expect(screen.getByTestId('theme').textContent).toBe('dark');
		} finally {
			if (storageDescriptor) {
				Object.defineProperty(window, 'localStorage', storageDescriptor);
			} else {
				Reflect.deleteProperty(window, 'localStorage');
			}
		}
	});

	test('syncs the latest stored theme across tabs without trusting stale events', async () => {
		renderTheme(<ThemeProbe />);

		localStorage.setItem(THEME_STORAGE_KEY, 'dark');
		act(() => {
			window.dispatchEvent(
				new StorageEvent('storage', {
					key: THEME_STORAGE_KEY,
					newValue: 'dark',
					storageArea: localStorage,
				}),
			);
		});

		await waitFor(() => expect(screen.getByTestId('theme').textContent).toBe('dark'));
		expect(document.documentElement.classList.contains('dark')).toBe(true);

		localStorage.setItem(THEME_STORAGE_KEY, 'light');
		act(() => {
			window.dispatchEvent(
				new StorageEvent('storage', {
					key: THEME_STORAGE_KEY,
					newValue: 'dark',
					storageArea: localStorage,
				}),
			);
		});
		expect(screen.getByTestId('theme').textContent).toBe('light');

		localStorage.clear();
		act(() => {
			window.dispatchEvent(
				new StorageEvent('storage', {key: null, newValue: null, storageArea: localStorage}),
			);
		});
		await waitFor(() => expect(screen.getByTestId('theme').textContent).toBe('system'));
	});
});

test('the sidebar menu selects and persists each theme', async () => {
	localStorage.setItem(THEME_STORAGE_KEY, 'dark');
	renderTheme(
		<TooltipProvider>
			<SidebarProvider>
				<ThemeMenu />
			</SidebarProvider>
		</TooltipProvider>,
	);

	fireEvent.click(screen.getByRole('button', {name: 'Theme: Dark'}));
	expect(screen.getByRole('group', {name: 'Theme'})).toBeTruthy();
	fireEvent.click(await screen.findByRole('menuitemradio', {name: 'Light'}));

	await waitFor(() => expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe('light'));
	expect(document.documentElement.classList.contains('light')).toBe(true);
});
