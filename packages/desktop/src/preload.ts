import {contextBridge, ipcRenderer, type IpcRendererEvent} from 'electron';

import {RESTART_CHANNEL, UPDATE_READY_CHANNEL} from './channels';

// What the page may ask of the app, as `window.personalAgentProxyDesktop`, typed on the web app's
// side in packages/web/src/lib/desktop.ts: whether an update is downloaded, word when one is, and
// the restart that installs it. The main process answers the app's own pages only (updates.ts).

contextBridge.exposeInMainWorld('personalAgentProxyDesktop', {
	updateReady: (): Promise<string | null> => ipcRenderer.invoke(UPDATE_READY_CHANNEL),
	onUpdateReady: (listener: (version: string) => void): (() => void) => {
		const handler = (_event: IpcRendererEvent, version: string) => listener(version);
		ipcRenderer.on(UPDATE_READY_CHANNEL, handler);
		return () => ipcRenderer.removeListener(UPDATE_READY_CHANNEL, handler);
	},
	restart: (): void => ipcRenderer.send(RESTART_CHANNEL),
});
