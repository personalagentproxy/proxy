// The app's own links, `personalagentproxy://…`, which the browser hands things back through:
// the one-time code of a sign-in (`auth-callback?code=`). macOS delivers them as the host form,
// `personalagentproxy://auth-callback?code=…`; the path form, with a third slash, is accepted too.

export const DEEP_LINK_SCHEME = 'personalagentproxy';

export type DeepLink = {kind: 'auth-callback'; code: string};

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
	if (target !== 'auth-callback') {
		return null;
	}

	const code = url.searchParams.get('code');
	if (!code) {
		return null;
	}

	return {kind: 'auth-callback', code};
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
