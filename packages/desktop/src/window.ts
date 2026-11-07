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
// origin, open in the browser, a page of the app's that sends the window elsewhere included.

// What the splash pages' buttons ask: intercepted as navigations, never loaded.
const SIGN_IN_URL = 'personalagentproxy-desktop://sign-in';
const RETRY_URL = 'personalagentproxy-desktop://retry';

const EXTERNAL_SCHEMES = new Set(['http:', 'https:', 'mailto:']);

// Plaid Link's frame, from which an OAuth bank's sign-in is opened.
const PLAID_LINK_ORIGIN = 'https://cdn.plaid.com';
const POPUP_BOUNDS = {width: 520, height: 760};

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

/** Whether the window is on a page of the web app, rather than a splash page or none. */
export function isAppPage(raw: string): boolean {
	return urlOf(raw)?.origin === APP_ORIGIN;
}

// The person's sign-in page. Not the agents' (/agent/login), which works in the window as it is.
function isLoginPage(url: URL): boolean {
	return url.origin === APP_ORIGIN && url.pathname === '/login';
}

// A page of the app's for the browser to run instead, as the web app has it run a service's
// sign-in (`onSignInClick` there): through the login page, which sends a signed-in browser
// straight on, and marked `?desktop=1` so it ends back in the app.
function inBrowser(url: URL): string {
	const page = new URL(url);
	page.searchParams.set('desktop', '1');
	return `${APP_URL}/login?callbackUrl=${encodeURIComponent(`${page.pathname}${page.search}`)}`;
}

// Whether Plaid Link is open on the page: one of the page's frames is Plaid's.
function hasPlaidLinkFrame(win: BrowserWindow): boolean {
	return win.webContents.mainFrame.framesInSubtree.some(
		(frame) => urlOf(frame.url)?.origin === PLAID_LINK_ORIGIN,
	);
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
		// Let the page fill the native title bar on macOS, with its traffic lights centered in the
		// page's taller bar (--desktop-title-bar-height in packages/web/src/index.css, 44px), where
		// the pages' headers sit. The page provides the drag surface the hidden frame no longer
		// supplies.
		...(process.platform === 'darwin'
			? {titleBarStyle: 'hidden', trafficLightPosition: {x: 16, y: 14}}
			: {}),
		// The window's icon where the window carries one, Windows and Linux, in a development run;
		// a packaged app has its own, and no build/ beside it.
		...(app.isPackaged ? {} : {icon: path.join(__dirname, '../build/icon.png')}),
		backgroundColor: nativeTheme.shouldUseDarkColors ? '#0a0a0a' : '#ffffff',
		// What the page may ask of the app (src/preload.ts), bundled beside the main process.
		webPreferences: {preload: path.join(__dirname, 'preload.cjs')},
	});

	keepWindowBounds(win);
	win.once('ready-to-show', () => win.show());

	// Links that open a new window, such as the docs', open in the browser. The one window opened
	// here is an OAuth bank's sign-in: Plaid Link, in its frame over the page, opens the bank's page
	// in a popup that reports back to Link and closes, which it can only do from a window of this
	// app's. With Link open the page under it is inert, so the popup is Link's.
	win.webContents.setWindowOpenHandler(({url}) => {
		if (hasPlaidLinkFrame(win)) {
			return {action: 'allow', overrideBrowserWindowOptions: {...POPUP_BOUNDS, parent: win}};
		}
		openExternal(url);
		return {action: 'deny'};
	});

	// The popup is the bank's: it goes where the bank's sign-in goes, and opens no windows of its
	// own.
	win.webContents.on('did-create-window', (popup) => {
		popup.webContents.setWindowOpenHandler(({url}) => {
			openExternal(url);
			return {action: 'deny'};
		});
	});

	// The page the window is on its way to, should it send the window on elsewhere.
	let navigatingTo: URL | null = null;

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
			return;
		}

		navigatingTo = url;
	});

	// A page of the app's that sends the window on to another origin, as the api's sign-in starts
	// send it to a provider's page, which would turn the window away as Google's does: the browser
	// gets the page the window was headed to, and runs it as the web app's own sign-in links are
	// run. The web app hands those to the browser itself; this catches a link it did not.
	win.webContents.on('will-redirect', (details) => {
		const target = urlOf(details.url);
		if (!details.isMainFrame || !target || isAllowed(target)) {
			return;
		}

		details.preventDefault();
		if (navigatingTo?.origin === APP_ORIGIN) {
			openExternal(inBrowser(navigatingTo));
			return;
		}

		openExternal(details.url);
	});

	// The app sends a signed-out person to its login page from within, which is no navigation to
	// intercept, so where the window ends up is watched too.
	const onArrived = (_event: Electron.Event, raw: string) => {
		navigatingTo = null;
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

		navigatingTo = null;
		// ERR_ABORTED: a navigation the window cancelled itself.
		if (errorCode === -3) {
			return;
		}

		load(win, splashUrl(offlineHtml));
	});

	return win;
}
