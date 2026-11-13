// The screens are the web app's routes, read from its router as text, so the map depends on
// nothing the web app exports and sees every route the moment it is added.
export const WEB_ROUTER_FILE = new URL('../../web/src/router.tsx', import.meta.url);

const ROUTE_PATH = /\bpath: '([^']+)'/g;

// Every route that renders a screen: not a catch-all, such as `/agent/*`, and not `/`, which only
// redirect.
export function routePaths(routerSource: string): string[] {
	const paths = [...routerSource.matchAll(ROUTE_PATH)]
		.map((match) => match[1] ?? '')
		.filter((path) => !path.endsWith('*') && path !== '/');
	return [...new Set(paths)];
}
