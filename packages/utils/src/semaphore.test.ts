import {expect, test} from 'bun:test';

import {semaphore} from './semaphore';

test('semaphore never runs more than the limit at once, and lets the next in as one ends, however it ends', async () => {
	const limit = semaphore(2);
	let running = 0;
	let most = 0;
	const work = async (ms: number, fail = false): Promise<number> => {
		running += 1;
		most = Math.max(most, running);
		await Bun.sleep(ms);
		running -= 1;
		if (fail) {
			throw new Error('failed');
		}
		return ms;
	};

	const results = await Promise.allSettled([
		limit.run(() => work(5)),
		limit.run(() => work(1, true)),
		limit.run(() => work(3)),
		limit.run(() => work(2)),
	]);

	expect(most).toBe(2);
	expect(results.map((result) => result.status)).toEqual([
		'fulfilled',
		'rejected',
		'fulfilled',
		'fulfilled',
	]);
	expect(running).toBe(0);
});
