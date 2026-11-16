/// <reference types="bun" />

import {describe, expect, mock, test} from 'bun:test';
import {Err, Ok} from 'ts-results-es';
import type {setTimeZone} from '@/client/me-client';
import {rememberBrowserTimeZone, timeZones} from '@/lib/person-time-zone';
import {browserTimeZone} from '@/lib/time-zone';

describe('rememberBrowserTimeZone', () => {
	test('sets the browser’s for a person without one, once, and again only after it failed', async () => {
		const save = mock<typeof setTimeZone>(async () => Ok(undefined));
		rememberBrowserTimeZone('Europe/Berlin', save);
		expect(save).not.toHaveBeenCalled();

		save.mockImplementationOnce(async () =>
			Err({kind: 'timeout', url: '/api/me/time-zone', timeoutMs: 1}),
		);
		rememberBrowserTimeZone(null, save);
		rememberBrowserTimeZone(null, save);
		expect(save).toHaveBeenCalledTimes(1);
		expect(save).toHaveBeenCalledWith(browserTimeZone());
		await Promise.resolve();
		await Promise.resolve();

		rememberBrowserTimeZone(null, save);
		expect(save).toHaveBeenCalledTimes(2);
		await Promise.resolve();
		rememberBrowserTimeZone(null, save);
		expect(save).toHaveBeenCalledTimes(2);
	});
});

describe('timeZones', () => {
	test('lists the browser’s, with one it doesn’t know put among them', () => {
		expect(timeZones(null)).toContain('Europe/Berlin');
		expect(timeZones('Mars/Olympus_Mons')).toContain('Mars/Olympus_Mons');
		expect(timeZones('Europe/Berlin').filter((zone) => zone === 'Europe/Berlin')).toHaveLength(1);
	});
});
