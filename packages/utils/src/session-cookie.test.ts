import {describe, expect, it} from 'bun:test';

import {getSessionTokenFromHeader, parseCookieHeader} from './session-cookie';

describe('getSessionTokenFromHeader', () => {
	it('reads the plain cookie', () => {
		expect(getSessionTokenFromHeader('a=1; proxy.session-token=abc; b=2')).toBe('abc');
	});

	it('prefers the secure cookie when both are present', () => {
		expect(
			getSessionTokenFromHeader('proxy.session-token=plain; __Secure-proxy.session-token=secure'),
		).toBe('secure');
	});

	it('returns null without a header or a session cookie', () => {
		expect(getSessionTokenFromHeader(undefined)).toBeNull();
		expect(getSessionTokenFromHeader('a=1')).toBeNull();
		expect(getSessionTokenFromHeader('proxy.session-token=')).toBeNull();
	});
});

describe('parseCookieHeader', () => {
	it('decodes values and keeps the raw value when decoding fails', () => {
		const cookies = parseCookieHeader('a=hello%20world; b=%E0%A4%A; malformed; c==x');

		expect(cookies.get('a')).toBe('hello world');
		expect(cookies.get('b')).toBe('%E0%A4%A');
		expect(cookies.has('malformed')).toBe(false);
		expect(cookies.get('c')).toBe('=x');
	});
});
