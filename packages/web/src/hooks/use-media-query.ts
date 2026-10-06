import {useSyncExternalStore} from 'react';

function subscribe(query: string, callback: () => void) {
	const list = window.matchMedia(query);
	list.addEventListener('change', callback);
	return () => list.removeEventListener('change', callback);
}

export function useMediaQuery(query: string): boolean {
	return useSyncExternalStore(
		(callback) => subscribe(query, callback),
		() => window.matchMedia(query).matches,
	);
}

// Tailwind's `md` breakpoint. Below it the app uses its phone layout.
const DESKTOP_QUERY = '(min-width: 768px)';

export function useDesktop(): boolean {
	return useMediaQuery(DESKTOP_QUERY);
}
