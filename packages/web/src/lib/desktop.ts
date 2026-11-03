// The desktop app, a window around this web app (packages/desktop). It signs in through the
// browser, which hands what it needs back through the app's own links, `personalagentproxy://…`.

const DESKTOP_SCHEME = 'personalagentproxy';

/** The link that hands the desktop app the one-time code it trades for a session. */
export function desktopAuthLink(code: string): string {
	return `${DESKTOP_SCHEME}://auth-callback?code=${encodeURIComponent(code)}`;
}
