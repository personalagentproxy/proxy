import type {IpcMainEvent, IpcMainInvokeEvent} from 'electron';

import {APP_ORIGIN} from './env';

/** Whether a page of the app's asks: a bank's sign-in popup has the window's preload too. */
export function fromApp(event: IpcMainEvent | IpcMainInvokeEvent): boolean {
	const url = event.senderFrame?.url;
	return url !== undefined && URL.canParse(url) && new URL(url).origin === APP_ORIGIN;
}
