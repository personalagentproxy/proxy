import {createContext, useContext} from 'react';
import {Result} from 'ts-results-es';

export type Theme = 'light' | 'dark' | 'system';

export const THEME_STORAGE_KEY = 'proxy-ui-theme';

export type ThemeProviderState = {
	theme: Theme;
	setTheme: (theme: Theme) => void;
};

export const ThemeProviderContext = createContext<ThemeProviderState | null>(null);

export function parseTheme(value: string | null): Theme | null {
	if (value === 'light' || value === 'dark' || value === 'system') {
		return value;
	}

	return null;
}

export function browserStorage(): Storage | null {
	const result = Result.wrap(() => window.localStorage);

	if (result.isErr()) {
		return null;
	}

	return result.value;
}

export function storedTheme(
	storage: Pick<Storage, 'getItem'> | null,
	storageKey: string,
): Theme | null {
	if (!storage) {
		return null;
	}

	const result = Result.wrap(() => storage.getItem(storageKey));

	if (result.isErr()) {
		return null;
	}

	return parseTheme(result.value);
}

export function storeTheme(
	storage: Pick<Storage, 'setItem'> | null,
	storageKey: string,
	theme: Theme,
): void {
	if (!storage) {
		return;
	}

	Result.wrap(() => storage.setItem(storageKey, theme));
}

export function useTheme(): ThemeProviderState {
	const context = useContext(ThemeProviderContext);

	if (!context) {
		throw new Error('useTheme must be used within a ThemeProvider');
	}

	return context;
}
