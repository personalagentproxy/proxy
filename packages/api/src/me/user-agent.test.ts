import {describe, expect, test} from 'bun:test';

import {describeUserAgent} from './user-agent';

describe('describeUserAgent', () => {
	test.each([
		['Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36', 'Chrome', 'macOS'],
		['Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Safari/605.1.15', 'Safari', 'macOS'],
		['Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:132.0) Gecko/20100101 Firefox/132.0', 'Firefox', 'Windows'],
		['Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 Edg/130.0.0.0', 'Edge', 'Windows'],
		['Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 OPR/114.0.0.0', 'Opera', 'Linux'],
		['Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1', 'Safari', 'iOS'],
		['Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/130.0.0.0 Mobile/15E148 Safari/604.1', 'Chrome', 'iOS'],
		['Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36', 'Chrome', 'Android'],
		['Mozilla/5.0 (X11; CrOS x86_64 14541.0.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36', 'Chrome', 'ChromeOS'],
		['Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) proxy-desktop/0.4.0 Chrome/130.0.6723.191 Electron/33.2.0 Safari/537.36', 'Desktop app', 'macOS'],
	])('%s', (userAgent, client, os) => {
		expect(describeUserAgent(userAgent)).toEqual({client, os, version: null});
	});

	test('reads the desktop app and its version from what the app adds', () => {
		expect(
			describeUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.7680.216 Electron/41.10.7 Safari/537.36 PersonalAgentProxyDesktop/0.0.5'),
		).toEqual({client: 'Desktop app', os: 'macOS', version: '0.0.5'});
	});

	test('says nothing it does not know', () => {
		expect(describeUserAgent(null)).toEqual({client: null, os: null, version: null});
		expect(describeUserAgent('curl/8.7.1')).toEqual({client: null, os: null, version: null});
	});
});
