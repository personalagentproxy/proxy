import {app, ipcMain, type BrowserWindow} from 'electron';
import {autoUpdater} from 'electron-updater';

import {
	RESTART_CHANNEL,
	UPDATE_CHECK_CHANNEL,
	UPDATE_READY_CHANNEL,
	UPDATE_STATUS_CHANNEL,
} from './channels';
import {fromApp} from './ipc';

// Updates, from the feed electron-builder.yml names: checked on start and every few hours, and
// when the page asks, as its Check for updates button does. A new version is downloaded as soon
// as it is found and announced to the page, which shows its notice with a restart button
// (packages/web/src/components/desktop-update-notice.tsx); put off, it is installed when the app
// next quits, so the next start is the new version either way. Where the check stands, through
// the download, is told to the page as it changes, for the button to say.

const CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000;

/** Where the update stands; `unavailable` in a development run, which has no feed. */
export type UpdateStatus =
	| {state: 'idle'}
	| {state: 'checking'}
	| {state: 'latest'}
	| {state: 'downloading'; version: string; percent: number}
	| {state: 'ready'; version: string}
	| {state: 'failed'}
	| {state: 'unavailable'};

let readyVersion: string | null = null;
let status: UpdateStatus = {state: 'idle'};

export function initUpdates(currentWindow: () => BrowserWindow | null): void {
	// Once one is downloaded, it is what the page hears of, whatever a later check finds, until a
	// newer one is downloaded in turn.
	function setStatus(next: UpdateStatus): void {
		if (readyVersion && next.state !== 'ready') {
			return;
		}
		status = next;
		currentWindow()?.webContents.send(UPDATE_STATUS_CHANNEL, next);
	}

	function check(): void {
		void autoUpdater.checkForUpdates().catch(() => undefined);
	}

	// A page loaded after the download, as one opened again from the Dock, asks.
	ipcMain.handle(UPDATE_READY_CHANNEL, (event) => (fromApp(event) ? readyVersion : null));
	ipcMain.handle(UPDATE_STATUS_CHANNEL, (event) => (fromApp(event) ? status : null));
	ipcMain.on(RESTART_CHANNEL, (event) => {
		if (!fromApp(event) || !readyVersion) {
			return;
		}
		autoUpdater.quitAndInstall();
	});

	// A development run has no feed, and an unsigned build can't be updated on macOS either way.
	if (!app.isPackaged) {
		status = {state: 'unavailable'};
		return;
	}

	// Asked while a check or its download runs, or with one downloaded, there is nothing to start.
	ipcMain.on(UPDATE_CHECK_CHANNEL, (event) => {
		if (!fromApp(event) || readyVersion) {
			return;
		}
		if (status.state === 'checking' || status.state === 'downloading') {
			return;
		}
		check();
	});

	autoUpdater.autoDownload = true;
	autoUpdater.autoInstallOnAppQuit = true;

	autoUpdater.on('checking-for-update', () => setStatus({state: 'checking'}));
	autoUpdater.on('update-not-available', () => setStatus({state: 'latest'}));
	autoUpdater.on('update-available', (info) =>
		setStatus({state: 'downloading', version: info.version, percent: 0}),
	);
	autoUpdater.on('download-progress', (progress) => {
		if (status.state !== 'downloading') {
			return;
		}
		setStatus({...status, percent: progress.percent});
	});
	autoUpdater.on('error', (error) => {
		console.warn('[updates] Checking for updates failed:', error.message);
		setStatus({state: 'failed'});
	});

	autoUpdater.on('update-downloaded', (info) => {
		readyVersion = info.version;
		setStatus({state: 'ready', version: info.version});
		currentWindow()?.webContents.send(UPDATE_READY_CHANNEL, info.version);
	});

	check();
	setInterval(check, CHECK_INTERVAL_MS);
}
