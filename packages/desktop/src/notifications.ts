import {app, ipcMain, Notification} from 'electron';
import {z} from 'zod';

import {BADGE_CHANNEL, NOTIFY_CHANNEL} from './channels';
import {fromApp} from './ipc';

// Notifications, as the page asks for them: what an agent said while the person was elsewhere,
// shown by the system, and the count of conversations with something unread on the app's badge.
// A notification clicked opens its conversation, the page it names, in the window.

const noticeSchema = z.object({title: z.string(), body: z.string(), path: z.string()});

export function initNotifications(openPath: (path: string) => void): void {
	ipcMain.on(NOTIFY_CHANNEL, (event, raw) => {
		const notice = noticeSchema.safeParse(raw);
		if (!fromApp(event) || !notice.success || !Notification.isSupported()) {
			return;
		}
		const shown = new Notification({title: notice.data.title, body: notice.data.body});
		shown.on('click', () => openPath(notice.data.path));
		shown.show();
	});

	ipcMain.on(BADGE_CHANNEL, (event, raw) => {
		const count = z.number().int().min(0).safeParse(raw);
		if (!fromApp(event) || !count.success) {
			return;
		}
		app.setBadgeCount(count.data);
	});
}
