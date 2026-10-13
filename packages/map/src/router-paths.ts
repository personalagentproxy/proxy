// The screens are the web app's routes, read from its router as text, so the map depends on
// nothing the web app exports and sees every route the moment it is added.
export const WEB_ROUTER_FILE = new URL('../../web/src/router.tsx', import.meta.url);

const ROUTE_PATH = /\bpath: '([^']+)'/g;

// Every route that renders a screen: not the catch-all, and not `/`, which only redirects.
export function routePaths(routerSource: string): string[] {
	const paths = [...routerSource.matchAll(ROUTE_PATH)]
		.map((match) => match[1] ?? '')
		.filter((path) => path !== '*' && path !== '/');
	return [...new Set(paths)];
}
