import {app, ipcMain, Notification} from 'electron';
import {z} from 'zod';

import {BADGE_CHANNEL, NOTIFY_CHANNEL} from './channels';
import {APP_ORIGIN} from './env';
import {fromApp} from './ipc';

// Notifications, as the page asks for them: what an agent said while the person was elsewhere,
// shown by the system, and the count of conversations with something unread on the app's badge.
// A notification clicked opens its conversation, the page it names, in the window.

// A page of the app, by its path: what it names, read as the page reads it, on the app's own
// origin, and passed on as read, so nothing the URL parser forgives, such as a backslash for a
// slash (`/\\host`) or a tab between two slashes, can name another host. The tag, one per
// conversation, is optional while pages from before it still ask.
const appPathSchema = z
	.string()
	.startsWith('/')
	.transform((raw, ctx) => {
		const url = URL.canParse(raw, APP_ORIGIN) ? new URL(raw, APP_ORIGIN) : null;
		if (url?.origin !== APP_ORIGIN) {
			ctx.addIssue({code: 'custom', message: 'Not a page of the app'});
			return z.NEVER;
		}
		return `${url.pathname}${url.search}${url.hash}`;
	});

const noticeSchema = z.object({
	title: z.string(),
	body: z.string(),
	path: appPathSchema,
	tag: z.string().optional(),
});

// The notifications on screen, held until they close: one only the system holds is collected,
// and its click with it. One per tag: a newer notice of the same tag closes the one showing, and
// is let go of then, as macOS may never say it closed. The system doesn't always say one was
// dismissed either, so only the latest are held: an older one may stay in the Notification
// Center, but its click opens no conversation.
const MAX_SHOWING = 20;
const showing = new Set<Notification>();
const tagged = new Map<string, Notification>();

function hold(shown: Notification, tag: string | undefined): void {
	showing.add(shown);
	if (tag !== undefined) {
		const before = tagged.get(tag);
		tagged.set(tag, shown);
		if (before !== undefined) {
			showing.delete(before);
			before.close();
		}
	}
	// A Set keeps the order things were added in: the first is the oldest.
	const oldest = showing.size > MAX_SHOWING ? showing.values().next().value : undefined;
	if (oldest === undefined) {
		return;
	}
	showing.delete(oldest);
	for (const [key, held] of tagged) {
		if (held === oldest) {
			tagged.delete(key);
		}
	}
}

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
		shown.on('close', () => forget(shown, tag));
		shown.on('click', () => {
			forget(shown, tag);
			openPath(path);
		});
		hold(shown, tag);
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
