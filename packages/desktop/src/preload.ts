import {contextBridge, ipcRenderer, type IpcRendererEvent, webFrame} from 'electron';

import {PRODUCTION_APP_URL} from './app-url';
import {RESTART_CHANNEL, UPDATE_READY_CHANNEL} from './channels';

const APP_ORIGIN = new URL(
	process.env.NODE_ENV === 'production'
		? PRODUCTION_APP_URL
		: (process.env.DESKTOP_APP_URL ?? 'http://localhost:5173'),
).origin;

// A newly installed shell can briefly load an older hosted web build during a rollout or rollback.
// Keep that page draggable and below the traffic lights until a title-bar-aware build adds the
// `desktop-app` class and takes over with its column-specific layout. Keep its 2rem height in step
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
			height: 2rem;
			border-bottom: 1px solid var(--border);
			content: '';
			-webkit-app-region: drag;
		}

		html:not(.desktop-app) #root > :first-child {
			box-sizing: border-box;
			padding-top: 2rem;
		}

		html:not(.desktop-app) [data-slot='sidebar-inner'] {
			padding-top: 2rem;
		}
	`);
}

// What the page may ask of the app, as `window.personalAgentProxyDesktop`, typed on the web app's
// side in packages/web/src/lib/desktop.ts: whether an update is downloaded, word when one is, and
// the restart that installs it. The main process answers the app's own pages only (updates.ts).

contextBridge.exposeInMainWorld('personalAgentProxyDesktop', {
	titleBarHidden: process.platform === 'darwin',
	updateReady: (): Promise<string | null> => ipcRenderer.invoke(UPDATE_READY_CHANNEL),
	onUpdateReady: (listener: (version: string) => void): (() => void) => {
		const handler = (_event: IpcRendererEvent, version: string) => listener(version);
		ipcRenderer.on(UPDATE_READY_CHANNEL, handler);
		return () => ipcRenderer.removeListener(UPDATE_READY_CHANNEL, handler);
	},
	restart: (): void => ipcRenderer.send(RESTART_CHANNEL),
});
