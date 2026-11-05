import {Result} from 'ts-results-es';
import {desktopBridge} from '@/lib/desktop';

// Word of a message from an agent that came while the person was elsewhere: a notification of
// the system's, through the desktop app where the page is in it, and through the browser's
// Notification API otherwise. Off until the person turns it on, on each device (Account page).

const SETTING_KEY = 'proxy-notifications';
// What was last told of, by the tag: shared by the page's tabs, so one tells of it and the rest don't.
const TOLD_KEY_PREFIX = 'proxy-notified:';

/**
 * A message as it is told of: whose, what it said, and the page of the app it is on; its tag, one
 * per conversation, and its id, the message's.
 */
export type Notice = {title: string; body: string; path: string; tag: string; id: string};

/** How this device can show notifications: through the desktop app, the browser, or not at all. */
export type NotificationSupport = 'desktop' | 'browser' | 'none';

export function notificationSupport(): NotificationSupport {
	if (desktopBridge()?.notify) {
		return 'desktop';
	}
	if (typeof Notification !== 'undefined') {
		return 'browser';
	}
	return 'none';
}

/**
 * Whether the person turned notifications on, on this device, and they can be shown: in the
 * browser, while it still lets the page, which may have been taken back in its settings since.
 */
export function notificationsOn(): boolean {
	if (localStorage.getItem(SETTING_KEY) !== 'on') {
		return false;
	}
	const support = notificationSupport();
	if (support === 'browser') {
		return Notification.permission === 'granted';
	}
	return support === 'desktop';
}

/** Whether the browser lets the page notify; a desktop app needs no leave, and takes the system's. */
export function notificationsBlocked(): boolean {
	return notificationSupport() === 'browser' && Notification.permission === 'denied';
}

/**
 * Turns notifications on for this device, asking the browser's leave where it is needed; false
 * where the browser refused, or has before, so they stay off.
 */
export async function turnNotificationsOn(): Promise<boolean> {
	const support = notificationSupport();
	if (support === 'none') {
		return false;
	}
	if (support === 'browser' && (await Notification.requestPermission()) !== 'granted') {
		return false;
	}
	localStorage.setItem(SETTING_KEY, 'on');
	return true;
}

export function turnNotificationsOff(): void {
	localStorage.removeItem(SETTING_KEY);
}

/**
 * Shows the notice, where notifications are on and no other tab of the page has; `open` is called
 * with its path when it is clicked in the browser (the desktop app hands that back through its
 * bridge, `onOpenPath`). One per conversation at a time: a newer notice of the same `tag`
 * replaces the one showing, and alerts again.
 */
export function notify(notice: Notice, open: (path: string) => void): void {
	if (!notificationsOn()) {
		return;
	}
	const {id, ...shownNotice} = notice;
	const toldKey = `${TOLD_KEY_PREFIX}${notice.tag}`;
	if (localStorage.getItem(toldKey) === id) {
		return;
	}
	const bridge = desktopBridge();
	if (bridge?.notify) {
		localStorage.setItem(toldKey, id);
		bridge.notify(shownNotice);
		return;
	}
	// A newer notice of the conversation alerts again as it replaces the one showing, as the
	// desktop app's does; `renotify` is the browsers', missing from TypeScript's DOM types.
	const options: NotificationOptions & {renotify: boolean} = {
		body: notice.body,
		tag: notice.tag,
		renotify: true,
	};
	// Where the page may not make one itself, as on Android, which shows them through a service
	// worker only, nothing is shown.
	const made = Result.wrap(() => new Notification(notice.title, options));
	if (made.isErr()) {
		return;
	}
	localStorage.setItem(toldKey, id);
	const shown = made.value;
	shown.onclick = () => {
		window.focus();
		open(notice.path);
		shown.close();
	};
}
