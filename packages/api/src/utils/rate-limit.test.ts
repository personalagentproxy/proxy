import {describe, expect, test} from 'bun:test';

import {createRateLimiter} from './rate-limit';

describe('createRateLimiter', () => {
	test('allows up to the limit within the window', () => {
		const limiter = createRateLimiter({limit: 2, windowMs: 1000});
		limiter.record('a', 0);
		expect(limiter.allows('a', 10)).toBe(true);
		limiter.record('a', 20);
		expect(limiter.allows('a', 30)).toBe(false);
		expect(limiter.allows('b', 30)).toBe(true);
	});

	test('forgets events once they leave the window', () => {
		const limiter = createRateLimiter({limit: 1, windowMs: 1000});
		limiter.record('a', 0);
		expect(limiter.allows('a', 999)).toBe(false);
		expect(limiter.allows('a', 1000)).toBe(true);
	});
});
