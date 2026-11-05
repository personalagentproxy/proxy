import {desktopBridge} from '@/lib/desktop';

// Word of a message from an agent that came while the person was elsewhere: a notification of
// the system's, through the desktop app where the page is in it, and through the browser's
// Notification API otherwise. Off until the person turns it on, on each device (Account page).

const SETTING_KEY = 'proxy-notifications';

/** A message as it is told of: whose, what it said, and the page of the app it is on. */
export type Notice = {title: string; body: string; path: string};

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

/** Whether the person turned notifications on, on this device. */
export function notificationsOn(): boolean {
	return localStorage.getItem(SETTING_KEY) === 'on';
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
 * Shows the notice, where notifications are on; `open` is called with its path when it is clicked
 * in the browser (the desktop app hands that back through its bridge, `onOpenPath`). One per
 * conversation at a time: a newer notice of the same `tag` replaces the one showing.
 */
export function notify(notice: Notice, tag: string, open: (path: string) => void): void {
	if (!notificationsOn()) {
		return;
	}
	const bridge = desktopBridge();
	if (bridge?.notify) {
		bridge.notify(notice);
		return;
	}
	if (typeof Notification === 'undefined' || Notification.permission !== 'granted') {
		return;
	}
	const shown = new Notification(notice.title, {body: notice.body, tag});
	shown.onclick = () => {
		window.focus();
		open(notice.path);
		shown.close();
	};
}
