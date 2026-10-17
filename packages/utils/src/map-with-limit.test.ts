import {expect, test} from 'bun:test';

import {mapWithLimit} from './map-with-limit';

test('mapWithLimit keeps the order and never runs more than the limit at once', async () => {
	let running = 0;
	let most = 0;
	const results = await mapWithLimit([5, 1, 4, 2, 3, 0, 6], 3, async (value) => {
		running += 1;
		most = Math.max(most, running);
		await Bun.sleep(value);
		running -= 1;
		return value * 10;
	});

	expect(results).toEqual([50, 10, 40, 20, 30, 0, 60]);
	expect(most).toBe(3);
});
