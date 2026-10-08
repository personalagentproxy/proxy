import {useEffect, useState, type ReactNode} from 'react';
import {
	browserStorage,
	storeTheme,
	storedTheme,
	THEME_STORAGE_KEY,
	ThemeProviderContext,
	type Theme,
	type ThemeProviderState,
} from '@/components/theme';

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

export function ThemeProvider({children}: ThemeProviderProps) {
	const storageKey = document.documentElement.dataset.themeStorageKey ?? THEME_STORAGE_KEY;
	const [storage] = useState(() => browserStorage());
	const [theme, setThemeState] = useState<Theme>(
		() => storedTheme(storage, storageKey) ?? 'system',
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

	useEffect(() => {
		const handleStorage = (event: StorageEvent) => {
			if (!storage || event.storageArea !== storage) {
				return;
			}

			if (event.key !== storageKey && event.key !== null) {
				return;
			}

			setThemeState(storedTheme(storage, storageKey) ?? 'system');
		};

		window.addEventListener('storage', handleStorage);

		return () => window.removeEventListener('storage', handleStorage);
	}, [storage, storageKey]);

	const value: ThemeProviderState = {
		theme,
		setTheme: (nextTheme) => {
			storeTheme(storage, storageKey, nextTheme);
			setThemeState(nextTheme);
		},
	};

	return <ThemeProviderContext.Provider value={value}>{children}</ThemeProviderContext.Provider>;
}
