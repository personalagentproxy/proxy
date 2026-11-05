import {app, ipcMain, Notification} from 'electron';
import {z} from 'zod';

import {BADGE_CHANNEL, NOTIFY_CHANNEL} from './channels';
import {fromApp} from './ipc';

// Notifications, as the page asks for them: what an agent said while the person was elsewhere,
// shown by the system, and the count of conversations with something unread on the app's badge.
// A notification clicked opens its conversation, the page it names, in the window.

// A page of the app, by its path: one slash at the start, so it can't name another host. The tag,
// one per conversation, is optional while pages from before it still ask.
const noticeSchema = z.object({
	title: z.string(),
	body: z.string(),
	path: z.string().regex(/^\/(?!\/)/),
	tag: z.string().optional(),
});

// The notifications on screen, held until they close: one only the system holds is collected,
// and its click with it. One per tag: a newer notice of the same tag closes the one showing.
const showing = new Set<Notification>();
const tagged = new Map<string, Notification>();

function forget(shown: Notification, tag: string | undefined): void {
	showing.delete(shown);
	if (tag !== undefined && tagged.get(tag) === shown) {
		tagged.delete(tag);
	}
}

export function initNotifications(openPath: (path: string) => void): void {
	ipcMain.on(NOTIFY_CHANNEL, (event, raw) => {
		const notice = noticeSchema.safeParse(raw);
		if (!fromApp(event) || !notice.success || !Notification.isSupported()) {
			return;
		}
		const {title, body, path, tag} = notice.data;
		const shown = new Notification({title, body});
		showing.add(shown);
		shown.on('close', () => forget(shown, tag));
		shown.on('click', () => {
			forget(shown, tag);
			openPath(path);
		});
		if (tag !== undefined) {
			const before = tagged.get(tag);
			tagged.set(tag, shown);
			before?.close();
		}
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
