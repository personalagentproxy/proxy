// The app's own links, `personalagentproxy://…`, which the browser hands things back through:
// the one-time code of a sign-in (`auth-callback?code=`), and the page of the app to open once
// the browser has done what the app handed it (`open?path=`). macOS delivers them as the host
// form, `personalagentproxy://auth-callback?code=…`; the path form, with a third slash, is
// accepted too.

export const DEEP_LINK_SCHEME = 'personalagentproxy';

export type DeepLink = {kind: 'auth-callback'; code: string} | {kind: 'open'; path: string};

// A page of the app: a path, never another site (`//evil.example`, or the backslash browsers
// take for a slash).
function isAppPath(path: string): boolean {
	return path.startsWith('/') && !path.startsWith('//') && !path.startsWith('/\\');
}

/** The link as what it asks for, or null for anything that isn't one of the app's. */
export function parseDeepLink(raw: string): DeepLink | null {
	if (!URL.canParse(raw)) {
		return null;
	}

	const url = new URL(raw);
	if (url.protocol !== `${DEEP_LINK_SCHEME}:`) {
		return null;
	}

	const target = url.hostname || url.pathname.replace(/^\/+/, '');
	if (target === 'auth-callback') {
		const code = url.searchParams.get('code');
		if (!code) {
			return null;
		}
		return {kind: 'auth-callback', code};
	}

	if (target === 'open') {
		const path = url.searchParams.get('path');
		if (!path || !isAppPath(path)) {
			return null;
		}
		return {kind: 'open', path};
	}

	return null;
}

/** The app's link among a command line's arguments, as Windows and Linux hand it to a second instance. */
export function findDeepLink(argv: string[]): DeepLink | null {
	for (const argument of argv) {
		const link = parseDeepLink(argument);
		if (link) {
			return link;
		}
	}

	return null;
}
