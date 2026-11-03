import type {FetchError} from '@proxy/utils';
import type {MouseEvent} from 'react';
import {Ok, type Result} from 'ts-results-es';
import {createDesktopHandoff} from '@/client/auth-client';

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

/** The link that hands the desktop app the one-time code it trades for a session. */
export function desktopAuthLink(code: string): string {
	return `${DESKTOP_SCHEME}://auth-callback?code=${encodeURIComponent(code)}`;
}

/** The link that opens `path`, a page of the app, in the desktop app, as the browser hands its work back. */
export function desktopOpenLink(path: string): string {
	return `${DESKTOP_SCHEME}://open?path=${encodeURIComponent(path)}`;
}

/**
 * Hands `next`, a path in the app, to the browser: the api gives an address that signs the
 * browser in as the same person, once, and sends it on, and the app opens every link out of its
 * window in the browser.
 */
export async function handOffToBrowser(next: string): Promise<Result<void, FetchError>> {
	const handoff = await createDesktopHandoff(next);
	if (handoff.isErr()) {
		return handoff;
	}
	window.open(handoff.value.url, '_blank');
	return Ok(undefined);
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
	void handOffToBrowser(`${url.pathname}${url.search}`).then((result) => {
		if (result.isErr()) {
			console.warn('Could not hand the sign-in to the browser', result.error.kind);
		}
	});
}
