import {app, ipcMain, type BrowserWindow} from 'electron';
import {autoUpdater} from 'electron-updater';

import {RESTART_CHANNEL, UPDATE_READY_CHANNEL} from './channels';
import {fromApp} from './ipc';

// Updates, from the feed electron-builder.yml names: checked on start and every few hours. A new
// version is downloaded as soon as it is found and announced to the page, which shows its notice
// with a restart button (packages/web/src/components/release-notice.tsx); put off, it is
// installed when the app next quits, so the next start is the new version either way.

const CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000;

let readyVersion: string | null = null;

export function initUpdates(currentWindow: () => BrowserWindow | null): void {
	// A page loaded after the download, as one opened again from the Dock, asks.
	ipcMain.handle(UPDATE_READY_CHANNEL, (event) => (fromApp(event) ? readyVersion : null));
	ipcMain.on(RESTART_CHANNEL, (event) => {
		if (!fromApp(event) || !readyVersion) {
			return;
		}
		autoUpdater.quitAndInstall();
	});

	// A development run has no feed, and an unsigned build can't be updated on macOS either way.
	if (!app.isPackaged) {
		return;
	}

	autoUpdater.autoDownload = true;
	autoUpdater.autoInstallOnAppQuit = true;

	autoUpdater.on('error', (error) => {
		console.warn('[updates] Checking for updates failed:', error.message);
	});

	autoUpdater.on('update-downloaded', (info) => {
		readyVersion = info.version;
		currentWindow()?.webContents.send(UPDATE_READY_CHANNEL, info.version);
	});

	void autoUpdater.checkForUpdates().catch(() => undefined);
	setInterval(() => {
		void autoUpdater.checkForUpdates().catch(() => undefined);
	}, CHECK_INTERVAL_MS);
}
