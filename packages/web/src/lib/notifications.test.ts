/// <reference types="bun" />

import {afterEach, beforeEach, describe, expect, mock, test} from 'bun:test';
import {
	notificationSupport,
	notificationsOn,
	notify,
	turnNotificationsOff,
	turnNotificationsOn,
} from '@/lib/notifications';

// A browser's Notification, as far as the page uses it: the leave it has, the one it asks for,
// and what was shown.
const shown: Array<{title: string; options?: NotificationOptions}> = [];
let permission: NotificationPermission = 'default';
class FakeNotification {
	static get permission() {
		return permission;
	}
	static requestPermission = mock(() => Promise.resolve(permission));
	onclick: (() => void) | null = null;
	close = mock(() => undefined);
	constructor(title: string, options?: NotificationOptions) {
		shown.push({title, options});
	}
}

const open = mock((_path: string) => undefined);
const notice = {title: 'Finance', body: 'Three invoices are due.', path: '/acme/chat/finance'};

beforeEach(() => {
	shown.length = 0;
	permission = 'default';
	open.mockClear();
	FakeNotification.requestPermission.mockClear();
	turnNotificationsOff();
	Object.assign(globalThis, {Notification: FakeNotification});
});

afterEach(() => {
	delete window.personalAgentProxyDesktop;
	Reflect.deleteProperty(globalThis, 'Notification');
});

describe('notifications', () => {
	test('are off until turned on, which asks the browser’s leave and keeps them off where it is refused', async () => {
		expect(notificationSupport()).toBe('browser');
		expect(notificationsOn()).toBe(false);

		permission = 'denied';
		expect(await turnNotificationsOn()).toBe(false);
		expect(notificationsOn()).toBe(false);

		permission = 'granted';
		expect(await turnNotificationsOn()).toBe(true);
		expect(notificationsOn()).toBe(true);

		turnNotificationsOff();
		expect(notificationsOn()).toBe(false);
	});

	test('show nothing while off, and through the browser once on, opening the page when clicked', async () => {
		permission = 'granted';
		notify(notice, 'finance', open);
		expect(shown).toEqual([]);

		await turnNotificationsOn();
		notify(notice, 'finance', open);
		expect(shown).toEqual([
			{title: 'Finance', options: {body: 'Three invoices are due.', tag: 'finance'}},
		]);
		expect(open).not.toHaveBeenCalled();
	});

	test('go through the desktop app where the page is in it, which needs no leave', async () => {
		const bridge = {
			updateReady: () => Promise.resolve(null),
			onUpdateReady: () => () => undefined,
			restart: () => undefined,
			notify: mock((_notice: typeof notice) => undefined),
			onOpenPath: () => () => undefined,
			setBadge: () => undefined,
		};
		window.personalAgentProxyDesktop = bridge;
		expect(notificationSupport()).toBe('desktop');

		expect(await turnNotificationsOn()).toBe(true);
		expect(FakeNotification.requestPermission).not.toHaveBeenCalled();
		notify(notice, 'finance', open);
		expect(bridge.notify).toHaveBeenCalledWith(notice);
		expect(shown).toEqual([]);
	});

	test('cannot be turned on where the device has no way to show them', async () => {
		Reflect.deleteProperty(globalThis, 'Notification');
		expect(notificationSupport()).toBe('none');
		expect(await turnNotificationsOn()).toBe(false);
	});
});
