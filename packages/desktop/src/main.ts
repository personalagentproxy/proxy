import path from 'node:path';

import {app, dialog, type BrowserWindow} from 'electron';

import {finishSignIn} from './auth';
import {OPEN_PATH_CHANNEL} from './channels';
import {DEEP_LINK_SCHEME, findDeepLink, parseDeepLink, type DeepLink} from './deep-link';
import {DESKTOP_VERSION} from './env';
import {initNotifications} from './notifications';
import {initUpdates} from './updates';
import {createMainWindow, isAppPage, loadApp, showSignIn} from './window';

// The desktop app: a window around the web app, hosted, with nothing of it bundled. The main
// process keeps the window, signs in through the browser, takes the app's links: the browser
// coming back from the sign-in, and from what the app hands it, as a service's sign-in is; and
// shows the notifications the page asks for.

// So the web app can tell it is in the desktop app, and which version.
app.userAgentFallback = `${app.userAgentFallback} PersonalAgentProxyDesktop/${DESKTOP_VERSION}`;

let mainWindow: BrowserWindow | null = null;

function currentWindow(): BrowserWindow | null {
	if (mainWindow && !mainWindow.isDestroyed()) {
		return mainWindow;
	}

	return null;
}

function window(): BrowserWindow {
	const open = currentWindow();
	if (open) {
		return open;
	}

	mainWindow = createMainWindow();
	return mainWindow;
}

function focusWindow(): BrowserWindow {
	const win = window();
	if (win.isMinimized()) {
		win.restore();
	}
	win.focus();
	return win;
}

// Opens a page of the app, as a notification clicked asks: in the window's page of the app, which
// moves there itself, or goes there where nothing on it listens (preload.ts), or loaded where the
// window has none, as on macOS after the window was closed, or on the splash pages, which can't.
function openPath(path: string): void {
	const open = currentWindow();
	const showsApp = open !== null && isAppPage(open.webContents.getURL());
	const win = focusWindow();
	if (!showsApp) {
		loadApp(win, path);
		return;
	}
	win.webContents.send(OPEN_PATH_CHANNEL, path);
}

async function onDeepLink(link: DeepLink): Promise<void> {
	await app.whenReady();
	const win = focusWindow();

	// The browser has done what the app handed it, such as connecting a service: on to where that
	// ended.
	if (link.kind === 'open') {
		loadApp(win, link.path);
		return;
	}

	const signedIn = await finishSignIn(link.code);
	if (signedIn.isErr()) {
		showSignIn(win);
		await dialog.showMessageBox(win, {
			type: 'error',
			message: 'Could not sign in',
			detail: signedIn.error,
		});
		return;
	}

	loadApp(win);
}

function start(): void {
	// One instance: a link opened while the app runs reaches it, not a second copy.
	if (!app.requestSingleInstanceLock()) {
		app.quit();
		return;
	}

	app.setAsDefaultProtocolClient(DEEP_LINK_SCHEME);

	// macOS hands the app its links as they are opened, running or not.
	app.on('open-url', (event, url) => {
		event.preventDefault();
		const link = parseDeepLink(url);
		if (link) {
			void onDeepLink(link);
		}
	});

	// Windows and Linux start a second instance with the link among its arguments, which comes here.
	app.on('second-instance', (_event, argv) => {
		const link = findDeepLink(argv);
		if (!link) {
			focusWindow();
			return;
		}
		void onDeepLink(link);
	});

	// On macOS the app stays open without a window, and the Dock icon opens one again.
	app.on('window-all-closed', () => {
		if (process.platform !== 'darwin') {
			app.quit();
		}
	});
	app.on('activate', () => {
		if (currentWindow()) {
			return;
		}
		loadApp(window());
	});

	void app.whenReady().then(() => {
		// A packaged app has its icon; a development run would show Electron's in the Dock.
		if (!app.isPackaged && process.platform === 'darwin') {
			app.dock?.setIcon(path.join(__dirname, '../build/icon.png'));
		}
		loadApp(window());
		initUpdates(currentWindow);
		initNotifications(openPath);
		const link = findDeepLink(process.argv);
		if (link) {
			void onDeepLink(link);
		}
	});
}

start();
