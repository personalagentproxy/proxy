'use client';

import {
	useCallback,
	useEffect,
	useRef,
	useState,
	useSyncExternalStore,
	type ReactNode,
} from 'react';
import {
	browserStorage,
	storeTheme,
	storedTheme,
	THEME_STORAGE_KEY,
	ThemeProviderContext,
	type Theme,
	type ThemeProviderState,
} from '@proxy/ui/lib/theme';

type ThemeProviderProps = {
	children: ReactNode;
};

function applyTheme(theme: Theme): void {
	const root = document.documentElement;
	const systemTheme = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
	const resolvedTheme = theme === 'system' ? systemTheme : theme;

	root.classList.remove('light', 'dark');
	root.classList.add(resolvedTheme);
}

// The theme is read from storage as an external store, so a page rendered on the server (the
// website, the docs) hydrates with 'system' and takes the saved theme right after, without a
// mismatch; the pre-paint script in each app's HTML has already applied the right class. The
// choice is kept in memory as well, for when storage is blocked.
function storageKeyOf(): string {
	if (typeof document === 'undefined') {
		return THEME_STORAGE_KEY;
	}

	return document.documentElement.dataset.themeStorageKey ?? THEME_STORAGE_KEY;
}

export function ThemeProvider({children}: ThemeProviderProps) {
	const [storage] = useState(() => browserStorage());
	const storageKey = storageKeyOf();
	const memory = useRef<Theme | null>(null);
	const listeners = useRef(new Set<() => void>());

	const subscribe = useCallback(
		(onChange: () => void) => {
			const handleStorage = (event: StorageEvent) => {
				if (!storage || event.storageArea !== storage) {
					return;
				}

				if (event.key !== storageKey && event.key !== null) {
					return;
				}

				memory.current = null;
				onChange();
			};

			listeners.current.add(onChange);
			window.addEventListener('storage', handleStorage);

			return () => {
				listeners.current.delete(onChange);
				window.removeEventListener('storage', handleStorage);
			};
		},
		[storage, storageKey],
	);

	const theme = useSyncExternalStore<Theme>(
		subscribe,
		() => storedTheme(storage, storageKey) ?? memory.current ?? 'system',
		() => 'system',
	);

	useEffect(() => {
		applyTheme(theme);

		if (theme !== 'system') {
			return;
		}

		const systemTheme = window.matchMedia('(prefers-color-scheme: dark)');
		const handleSystemThemeChange = () => applyTheme('system');

		systemTheme.addEventListener('change', handleSystemThemeChange);

		return () => systemTheme.removeEventListener('change', handleSystemThemeChange);
	}, [theme]);

	const value: ThemeProviderState = {
		theme,
		setTheme: (nextTheme) => {
			memory.current = nextTheme;
			storeTheme(storage, storageKey, nextTheme);
			listeners.current.forEach((listener) => listener());
		},
	};

	return <ThemeProviderContext.Provider value={value}>{children}</ThemeProviderContext.Provider>;
}
