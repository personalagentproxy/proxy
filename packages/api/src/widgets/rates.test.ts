import {describe, expect, spyOn, test} from 'bun:test';

const fetchSpy = spyOn(globalThis, 'fetch').mockImplementation((async () =>
	Response.json({amount: 1, base: 'EUR', date: '2026-10-14', rates: {USD: 1.1195, GBP: 0.84385}})) as unknown as typeof fetch);

describe('handleRatesRoute', () => {
	test("answers the bank's rates of the day, the euro's own among them, asked for once an hour", async () => {
		const {handleRatesRoute} = await import('./rates');

		expect((await handleRatesRoute()).unwrap()).toEqual({date: '2026-10-14', rates: {EUR: 1, USD: 1.1195, GBP: 0.84385}});
		await handleRatesRoute();
		expect(fetchSpy).toHaveBeenCalledTimes(1);
	});
});
