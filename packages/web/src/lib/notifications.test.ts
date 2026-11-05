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
// and what was shown, `renotify` with it, which TypeScript's DOM types leave out.
type ShownOptions = NotificationOptions & {renotify?: boolean};
const shown: Array<{title: string; options?: ShownOptions}> = [];
let permission: NotificationPermission = 'default';
// Whether the page may make one itself: not on Android, whose browser throws.
let constructible = true;
class FakeNotification {
	static get permission() {
		return permission;
	}
	static requestPermission = mock(() => Promise.resolve(permission));
	onclick: (() => void) | null = null;
	close = mock(() => undefined);
	constructor(title: string, options?: ShownOptions) {
		if (!constructible) {
			throw new TypeError('Illegal constructor.');
		}
		shown.push({title, options});
	}
}

const open = mock((_path: string) => undefined);
const notice = {
	title: 'Finance',
	body: 'Three invoices are due.',
	path: '/acme/chat/finance',
	tag: 'finance',
	id: 'answer-1',
};

beforeEach(() => {
	shown.length = 0;
	permission = 'default';
	constructible = true;
	open.mockClear();
	FakeNotification.requestPermission.mockClear();
	turnNotificationsOff();
	localStorage.clear();
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

	test('are off where the browser has taken its leave back since, so turning them on asks again', async () => {
		permission = 'granted';
		await turnNotificationsOn();
		expect(notificationsOn()).toBe(true);

		permission = 'default';
		expect(notificationsOn()).toBe(false);
		notify(notice, open);
		expect(shown).toEqual([]);
	});

	test('show nothing while off, and through the browser once on, opening the page when clicked', async () => {
		permission = 'granted';
		notify(notice, open);
		expect(shown).toEqual([]);

		await turnNotificationsOn();
		notify(notice, open);
		expect(shown).toEqual([
			{
				title: 'Finance',
				options: {body: 'Three invoices are due.', tag: 'finance', renotify: true},
			},
		]);
		expect(open).not.toHaveBeenCalled();
	});

	test('tell of a message once across the page’s tabs, and of the next one again', async () => {
		permission = 'granted';
		await turnNotificationsOn();

		notify(notice, open);
		notify(notice, open);
		expect(shown).toHaveLength(1);

		notify({...notice, body: 'And one more.', id: 'answer-2'}, open);
		expect(shown).toHaveLength(2);
		expect(shown[1]?.options?.body).toBe('And one more.');
	});

	test('tell of a message again that could not be shown, where the leave was taken back or the browser refused to make it', async () => {
		permission = 'granted';
		await turnNotificationsOn();

		permission = 'denied';
		notify(notice, open);
		constructible = false;
		permission = 'granted';
		notify(notice, open);
		expect(shown).toEqual([]);

		constructible = true;
		notify(notice, open);
		expect(shown).toHaveLength(1);
	});

	test('go through the desktop app where the page is in it, which needs no leave', async () => {
		const bridge = {
			updateReady: () => Promise.resolve(null),
			onUpdateReady: () => () => undefined,
			restart: () => undefined,
			notify: mock((_notice: Omit<typeof notice, 'id'>) => undefined),
			onOpenPath: () => () => undefined,
			setBadge: () => undefined,
		};
		window.personalAgentProxyDesktop = bridge;
		expect(notificationSupport()).toBe('desktop');

		expect(await turnNotificationsOn()).toBe(true);
		expect(FakeNotification.requestPermission).not.toHaveBeenCalled();
		notify(notice, open);
		expect(bridge.notify).toHaveBeenCalledWith({
			title: 'Finance',
			body: 'Three invoices are due.',
			path: '/acme/chat/finance',
			tag: 'finance',
		});
		expect(shown).toEqual([]);
	});

	test('cannot be turned on where the device has no way to show them', async () => {
		Reflect.deleteProperty(globalThis, 'Notification');
		expect(notificationSupport()).toBe('none');
		expect(await turnNotificationsOn()).toBe(false);
	});
});
