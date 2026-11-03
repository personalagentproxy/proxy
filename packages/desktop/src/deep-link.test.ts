import {describe, expect, test} from 'bun:test';

import {findDeepLink, parseDeepLink} from './deep-link';

describe('parseDeepLink', () => {
	test('reads the host form, as macOS delivers it', () => {
		expect(parseDeepLink('personalagentproxy://auth-callback?code=abc123')).toEqual({
			kind: 'auth-callback',
			code: 'abc123',
		});
	});

	test('reads the path form', () => {
		expect(parseDeepLink('personalagentproxy:///auth-callback?code=abc123')).toEqual({
			kind: 'auth-callback',
			code: 'abc123',
		});
	});

	test('is only for the app’s own scheme', () => {
		expect(parseDeepLink('https://auth-callback?code=abc123')).toBeNull();
		expect(parseDeepLink('personalagentproxy-evil://auth-callback?code=abc123')).toBeNull();
	});

	test('reads the page to open, a path in the app', () => {
		expect(
			parseDeepLink('personalagentproxy://open?path=%2Facme%2Fconnections%2Fc-1%3Fadded'),
		).toEqual({
			kind: 'open',
			path: '/acme/connections/c-1?added',
		});
	});

	test('opens no other site', () => {
		expect(parseDeepLink('personalagentproxy://open?path=https%3A%2F%2Fevil.example')).toBeNull();
		expect(parseDeepLink('personalagentproxy://open?path=%2F%2Fevil.example')).toBeNull();
		expect(parseDeepLink('personalagentproxy://open?path=%2F%5Cevil.example')).toBeNull();
		expect(parseDeepLink('personalagentproxy://open')).toBeNull();
	});

	test('knows no other target', () => {
		expect(parseDeepLink('personalagentproxy://open-project?id=123')).toBeNull();
	});

	test('needs a code', () => {
		expect(parseDeepLink('personalagentproxy://auth-callback')).toBeNull();
		expect(parseDeepLink('personalagentproxy://auth-callback?code=')).toBeNull();
	});

	test('is not a link at all', () => {
		expect(parseDeepLink('not a url')).toBeNull();
	});
});

describe('findDeepLink', () => {
	test('finds the link among a second instance’s arguments', () => {
		expect(
			findDeepLink([
				'/Applications/App',
				'--no-sandbox',
				'personalagentproxy://auth-callback?code=x',
			]),
		).toEqual({kind: 'auth-callback', code: 'x'});
	});

	test('finds none in a plain launch', () => {
		expect(findDeepLink(['/Applications/App', '.'])).toBeNull();
	});
});
