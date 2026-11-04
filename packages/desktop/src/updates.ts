import {app, dialog} from 'electron';
import {autoUpdater} from 'electron-updater';

// Updates, from the feed electron-builder.yml names: checked on start and every few hours, and
// installed when the person says so.

const CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000;

export function initUpdates(): void {
	// A development run has no feed, and an unsigned build can't be updated on macOS either way.
	if (!app.isPackaged) {
		return;
	}

	autoUpdater.on('error', (error) => {
		console.warn('[updates] Checking for updates failed:', error.message);
	});

	autoUpdater.on('update-downloaded', (info) => {
		void dialog
			.showMessageBox({
				type: 'info',
				message: `Personal Agent Proxy ${info.version} is ready to install`,
				buttons: ['Restart now', 'Later'],
				defaultId: 0,
				cancelId: 1,
			})
			.then(({response}) => {
				if (response === 0) {
					autoUpdater.quitAndInstall();
				}
			});
	});

	void autoUpdater.checkForUpdates().catch(() => undefined);
	setInterval(() => {
		void autoUpdater.checkForUpdates().catch(() => undefined);
	}, CHECK_INTERVAL_MS);
}
