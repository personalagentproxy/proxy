import {contextBridge, ipcRenderer, type IpcRendererEvent, webFrame} from 'electron';

import {PRODUCTION_APP_URL} from './app-url';
import {
	BADGE_CHANNEL,
	CLAUDE_SIGN_IN_FINISH_CHANNEL,
	CLAUDE_SIGN_IN_START_CHANNEL,
	NOTIFY_CHANNEL,
	OPEN_PATH_CHANNEL,
	RESTART_CHANNEL,
	UPDATE_CHECK_CHANNEL,
	UPDATE_READY_CHANNEL,
	UPDATE_STATUS_CHANNEL,
} from './channels';
import type {UpdateStatus} from './updates';

const APP_ORIGIN = new URL(
	process.env.NODE_ENV === 'production'
		? PRODUCTION_APP_URL
		: (process.env.DESKTOP_APP_URL ?? 'http://localhost:5173'),
).origin;

// A newly installed shell can briefly load an older hosted web build during a rollout or rollback.
// Keep that page draggable and below the traffic lights until a title-bar-aware build adds the
// `desktop-app` class and takes over with its column-specific layout. Keep its 2.75rem height in step
// with packages/desktop/src/templates/splash.css and packages/web/src/index.css.
if (process.platform === 'darwin' && window.location.origin === APP_ORIGIN) {
	void webFrame.insertCSS(`
		html:not(.desktop-app) body::before {
			position: fixed;
			z-index: 60;
			top: 0;
			right: 0;
			left: 0;
			box-sizing: border-box;
			height: 2.75rem;
			border-bottom: 1px solid var(--border);
			content: '';
			-webkit-app-region: drag;
		}

		html:not(.desktop-app) #root > :first-child {
			box-sizing: border-box;
			padding-top: 2.75rem;
		}

		html:not(.desktop-app) [data-slot='sidebar-inner'] {
			padding-top: 2.75rem;
		}
	`);
}

// What the page may ask of the app, as `window.personalAgentProxyDesktop`, typed on the web app's
// side in packages/web/src/lib/desktop.ts: whether an update is downloaded, word when one is, and
// the restart that installs it; where the update stands, word as that changes, and a check begun
// now; a notification shown, word of the page one opens when clicked,
// and the count on the app's badge; and the Claude sign-in, begun in the browser and finished
// with the code pasted from it, which answers the token for the page to connect. The main process
// answers the app's own pages only (updates.ts, notifications.ts, main.ts).

// The page's listeners for a notification clicked. Where none listens, as on the sign-in page or
// the agents' pages, the page goes to the notification's own: a path of the app's, as the main
// process has checked.
const openPathListeners = new Set<(path: string) => void>();
ipcRenderer.on(OPEN_PATH_CHANNEL, (_event: IpcRendererEvent, path: string) => {
	if (openPathListeners.size === 0) {
		window.location.assign(path);
		return;
	}
	for (const listener of openPathListeners) {
		listener(path);
	}
});

contextBridge.exposeInMainWorld('personalAgentProxyDesktop', {
	titleBarHidden: process.platform === 'darwin',
	updateReady: (): Promise<string | null> => ipcRenderer.invoke(UPDATE_READY_CHANNEL),
	onUpdateReady: (listener: (version: string) => void): (() => void) => {
		const handler = (_event: IpcRendererEvent, version: string) => listener(version);
		ipcRenderer.on(UPDATE_READY_CHANNEL, handler);
		return () => ipcRenderer.removeListener(UPDATE_READY_CHANNEL, handler);
	},
	restart: (): void => ipcRenderer.send(RESTART_CHANNEL),
	updateStatus: (): Promise<UpdateStatus | null> => ipcRenderer.invoke(UPDATE_STATUS_CHANNEL),
	onUpdateStatus: (listener: (status: UpdateStatus) => void): (() => void) => {
		const handler = (_event: IpcRendererEvent, status: UpdateStatus) => listener(status);
		ipcRenderer.on(UPDATE_STATUS_CHANNEL, handler);
		return () => ipcRenderer.removeListener(UPDATE_STATUS_CHANNEL, handler);
	},
	checkForUpdates: (): void => ipcRenderer.send(UPDATE_CHECK_CHANNEL),
	notify: (notice: {title: string; body: string; path: string; tag: string}): void =>
		ipcRenderer.send(NOTIFY_CHANNEL, notice),
	onOpenPath: (listener: (path: string) => void): (() => void) => {
		openPathListeners.add(listener);
		return () => {
			openPathListeners.delete(listener);
		};
	},
	setBadge: (count: number): void => ipcRenderer.send(BADGE_CHANNEL, count),
	claudeSignIn: {
		start: (): Promise<{ok: true} | {error: string}> =>
			ipcRenderer.invoke(CLAUDE_SIGN_IN_START_CHANNEL),
		finish: (code: string): Promise<{token: string; expiresAt: string} | {error: string}> =>
			ipcRenderer.invoke(CLAUDE_SIGN_IN_FINISH_CHANNEL, code),
	},
});
