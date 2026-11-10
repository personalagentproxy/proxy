import type {MouseEvent} from 'react';

// The desktop app, a window around this web app (packages/desktop). It signs in through the
// browser, which hands what it needs back through the app's own links, `personalagentproxy://…`,
// and hands the browser what has to happen there: a service's sign-in, whose page turns the
// app's window away as Google's does.

const DESKTOP_SCHEME = 'personalagentproxy';

// What the app adds to its user agent.
const DESKTOP_USER_AGENT = 'PersonalAgentProxyDesktop/';

/** Whether this is the desktop app's window. */
export function isDesktopApp(): boolean {
	return navigator.userAgent.includes(DESKTOP_USER_AGENT);
}

/** The desktop app's version, as its user agent says it; null in a browser. */
export function desktopVersion(): string | null {
	const at = navigator.userAgent.indexOf(DESKTOP_USER_AGENT);
	if (at === -1) {
		return null;
	}
	return navigator.userAgent.slice(at + DESKTOP_USER_AGENT.length).split(' ')[0] || null;
}

/**
 * The desktop app's Claude sign-in (`packages/desktop/src/claude-sign-in.ts`): `start` opens
 * Claude's sign-in page in the browser, where the person is shown a code; `finish` trades the
 * pasted code for a year's token, minted on their computer, with when it ends, for the page to
 * connect through the api. Either answers what went wrong instead, in words for the person.
 */
export type DesktopClaudeSignIn = {
	start(): Promise<{ok: true} | {error: string}>;
	finish(code: string): Promise<{token: string; expiresAt: string} | {error: string}>;
};

/**
 * Where the desktop app's update stands (`packages/desktop/src/updates.ts`): looked for, found and
 * downloading, downloaded and installed by a restart, none newer, the look failed, or, in a
 * development run, no updates at all.
 */
export type DesktopUpdateStatus =
	| {state: 'idle'}
	| {state: 'checking'}
	| {state: 'latest'}
	| {state: 'downloading'; version: string; percent: number}
	| {state: 'ready'; version: string}
	| {state: 'failed'}
	| {state: 'unavailable'};

/**
 * What the desktop app's window gives its pages (`packages/desktop/src/preload.ts`): the version
 * of an update it has downloaded, if any, word when it downloads one, and the restart that installs
 * it; where the update stands, word as that changes, and a look for one begun now; notifications, shown by the app, which hands back the page one opens when clicked, and the
 * count on its badge; and the Claude sign-in.
 */
export type DesktopBridge = {
	// Optional while installed desktop apps from before the hidden title bar still load this page.
	titleBarHidden?: boolean;
	updateReady(): Promise<string | null>;
	onUpdateReady(listener: (version: string) => void): () => void;
	restart(): void;
	// Optional while installed desktop apps from before the update check still load this page.
	updateStatus?(): Promise<DesktopUpdateStatus | null>;
	onUpdateStatus?(listener: (status: DesktopUpdateStatus) => void): () => void;
	checkForUpdates?(): void;
	// Optional while installed desktop apps from before notifications still load this page.
	notify?(notice: {title: string; body: string; path: string; tag: string}): void;
	onOpenPath?(listener: (path: string) => void): () => void;
	setBadge?(count: number): void;
	// Optional while installed desktop apps from before the Claude sign-in still load this page.
	claudeSignIn?: DesktopClaudeSignIn;
};

declare global {
	interface Window {
		personalAgentProxyDesktop?: DesktopBridge;
	}
}

/** The desktop app's bridge; null in a browser. */
export function desktopBridge(): DesktopBridge | null {
	return window.personalAgentProxyDesktop ?? null;
}

/** The desktop app's Claude sign-in; null in a browser, and in a desktop app from before it. */
export function claudeSignIn(): DesktopClaudeSignIn | null {
	return desktopBridge()?.claudeSignIn ?? null;
}

/** Whether this desktop shell removed its native title bar and needs the page to replace it. */
export function hasHiddenDesktopTitleBar(): boolean {
	return desktopBridge()?.titleBarHidden === true;
}

/** The link that hands the desktop app the one-time code it trades for a session. */
export function desktopAuthLink(code: string): string {
	return `${DESKTOP_SCHEME}://auth-callback?code=${encodeURIComponent(code)}`;
}

/** The link that opens `path`, a page of the app, in the desktop app, as the browser hands its work back. */
export function desktopOpenLink(path: string): string {
	return `${DESKTOP_SCHEME}://open?path=${encodeURIComponent(path)}`;
}

/**
 * Hands `next`, a path in the app, to the browser, where the app opens every link out of its
 * window. The browser goes through the login page, which sends a signed-in browser straight on
 * and lets any other sign in first: the browser is signed in as whoever holds it, never as
 * whoever holds the app, so nothing the app mints could sign someone else in.
 */
export function handOffToBrowser(next: string): void {
	window.open(`${window.location.origin}/login?callbackUrl=${encodeURIComponent(next)}`, '_blank');
}

/**
 * On a link that starts a service's sign-in: in the desktop app, the sign-in runs in the browser
 * instead, marked `?desktop=1` so it ends back in the app (`/desktop-return`). In the browser, the
 * link is followed as it is.
 */
export function onSignInClick(event: MouseEvent<HTMLAnchorElement>): void {
	if (!isDesktopApp()) {
		return;
	}
	event.preventDefault();
	const url = new URL(event.currentTarget.href);
	url.searchParams.set('desktop', '1');
	handOffToBrowser(`${url.pathname}${url.search}`);
}
