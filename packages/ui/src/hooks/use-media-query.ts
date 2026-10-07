import {useSyncExternalStore} from 'react';

function subscribe(query: string, callback: () => void) {
	const list = window.matchMedia(query);
	list.addEventListener('change', callback);
	return () => list.removeEventListener('change', callback);
}

// `serverMatches` is what a server render assumes, before the browser can answer the query.
export function useMediaQuery(query: string, serverMatches = false): boolean {
	return useSyncExternalStore(
		(callback) => subscribe(query, callback),
		() => window.matchMedia(query).matches,
		() => serverMatches,
	);
}

// Tailwind's `md` breakpoint. Below it the app uses its phone layout. A server render assumes a
// desktop, whose layout hides itself on phones with CSS until the browser takes over.
const DESKTOP_QUERY = '(min-width: 768px)';

export function useDesktop(): boolean {
	return useMediaQuery(DESKTOP_QUERY, true);
}
