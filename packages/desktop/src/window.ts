import path from 'node:path';

import {app, BrowserWindow, nativeTheme, net, shell} from 'electron';

import {beginSignIn} from './auth';
import {APP_ORIGIN, APP_URL} from './env';
import offlineHtml from './templates/offline.tpl.html';
import signInHtml from './templates/sign-in.tpl.html';
import splashCss from './templates/splash.css';
import {initialWindowBounds, keepWindowBounds} from './window-state';

// The window: the web app, and in its place, when there is no one signed in or no connection,
// one of two pages of the app's own. Links out of the app, and anything but the app's own
// origin, open in the browser.

// What the splash pages' buttons ask: intercepted as navigations, never loaded.
const SIGN_IN_URL = 'personalagentproxy-desktop://sign-in';
const RETRY_URL = 'personalagentproxy-desktop://retry';

const EXTERNAL_SCHEMES = new Set(['http:', 'https:', 'mailto:']);

function urlOf(raw: string): URL | null {
	if (!URL.canParse(raw)) {
		return null;
	}

	return new URL(raw);
}

// A load that fails, or is cut short by the next one, is reported by did-fail-load; the promise's
// rejection says nothing more.
function load(win: BrowserWindow, url: string): void {
	win.loadURL(url).catch(() => undefined);
}

// The splash pages share a stylesheet, in a comment the page keeps a place for, and follow the
// system's appearance: the app's own theme setting lives in its pages, out of reach here.
function splashUrl(html: string): string {
	const styled = html.replace('/* splash.css */', splashCss);
	const themed = nativeTheme.shouldUseDarkColors
		? styled.replace('<html>', '<html class="dark">')
		: styled;
	return `data:text/html;charset=utf-8,${encodeURIComponent(themed)}`;
}

// The app's own origin, and the splash pages.
function isAllowed(url: URL): boolean {
	return url.protocol === 'data:' || url.origin === APP_ORIGIN;
}

// The person's sign-in page. Not the agents' (/agent/login), which works in the window as it is.
function isLoginPage(url: URL): boolean {
	return url.origin === APP_ORIGIN && url.pathname === '/login';
}

export function openExternal(raw: string): void {
	const url = urlOf(raw);
	if (!url || !EXTERNAL_SCHEMES.has(url.protocol)) {
		return;
	}

	void shell.openExternal(raw);
}

/** The page that offers signing in: shown where the app would show its login page. */
export function showSignIn(win: BrowserWindow): void {
	load(win, splashUrl(signInHtml));
}

/** Opens the browser on the sign-in, with a fresh challenge, and waits for it to come back. */
export function startSignIn(win: BrowserWindow): void {
	showSignIn(win);
	openExternal(beginSignIn());
}

/** The web app, or, with no connection, the page that says so. */
export function loadApp(win: BrowserWindow, path = '/'): void {
	if (!net.isOnline()) {
		load(win, splashUrl(offlineHtml));
		return;
	}

	load(win, `${APP_URL}${path}`);
}

export function createMainWindow(): BrowserWindow {
	const win = new BrowserWindow({
		...initialWindowBounds(),
		show: false,
		minWidth: 800,
		minHeight: 600,
		// The window's icon where the window carries one, Windows and Linux, in a development run;
		// a packaged app has its own, and no build/ beside it.
		...(app.isPackaged ? {} : {icon: path.join(__dirname, '../build/icon.png')}),
		backgroundColor: nativeTheme.shouldUseDarkColors ? '#0a0a0a' : '#ffffff',
	});

	keepWindowBounds(win);
	win.once('ready-to-show', () => win.show());

	// Links that open a new window, such as the docs', open in the browser.
	win.webContents.setWindowOpenHandler(({url}) => {
		openExternal(url);
		return {action: 'deny'};
	});

	win.webContents.on('will-navigate', (event, raw) => {
		if (raw === SIGN_IN_URL) {
			event.preventDefault();
			startSignIn(win);
			return;
		}

		if (raw === RETRY_URL) {
			event.preventDefault();
			loadApp(win);
			return;
		}

		const url = urlOf(raw);
		if (!url) {
			event.preventDefault();
			return;
		}

		if (isLoginPage(url)) {
			event.preventDefault();
			showSignIn(win);
			return;
		}

		if (!isAllowed(url)) {
			event.preventDefault();
			openExternal(raw);
		}
	});

	// The app sends a signed-out person to its login page from within, which is no navigation to
	// intercept, so where the window ends up is watched too.
	const onArrived = (_event: Electron.Event, raw: string) => {
		const url = urlOf(raw);
		if (url && isLoginPage(url)) {
			showSignIn(win);
		}
	};
	win.webContents.on('did-navigate', onArrived);
	win.webContents.on('did-navigate-in-page', onArrived);

	win.webContents.on('did-fail-load', (_event, errorCode, _description, _url, isMainFrame) => {
		if (!isMainFrame) {
			return;
		}

		// ERR_ABORTED: a navigation the window cancelled itself.
		if (errorCode === -3) {
			return;
		}

		load(win, splashUrl(offlineHtml));
	});

	return win;
}
