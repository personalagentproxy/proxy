import {describe, expect, test} from 'bun:test';

import {convert, findUnit, UNITS, type Unit} from './units';

function unit(id: string): Unit {
	const found = findUnit(id);
	if (!found) {
		throw new Error(`No unit ${id}`);
	}
	return found;
}

describe('units', () => {
	test('converts within a kind', () => {
		expect(convert(5, unit('mi'), unit('km'))).toBeCloseTo(8.04672, 5);
		expect(convert(2, unit('lb'), unit('kg'))).toBeCloseTo(0.90718, 5);
		expect(convert(3, unit('cup'), unit('ml'))).toBeCloseTo(709.765, 3);
		expect(convert(100, unit('kmh'), unit('mph'))).toBeCloseTo(62.137, 3);
		expect(convert(1, unit('gb'), unit('mb'))).toBe(1000);
	});

	test('moves a temperature’s zero', () => {
		expect(convert(72, unit('f'), unit('c'))).toBeCloseTo(22.222, 3);
		expect(convert(-40, unit('c'), unit('f'))).toBeCloseTo(-40, 6);
		expect(convert(0, unit('k'), unit('c'))).toBeCloseTo(-273.15, 6);
	});

	test("converts money at the day's rates, and none without them", () => {
		const rates = {EUR: 1, USD: 1.1195, GBP: 0.84385};
		expect(convert(56, unit('usd'), unit('eur'), rates)).toBeCloseTo(50.0223, 4);
		expect(convert(100, unit('gbp'), unit('usd'), rates)).toBeCloseTo(132.666, 3);
		expect(convert(56, unit('usd'), unit('eur'))).toBeNull();
		expect(convert(56, unit('usd'), unit('jpy'), rates)).toBeNull();
	});

	test('converts nothing between kinds', () => {
		expect(convert(1, unit('kg'), unit('mi'))).toBeNull();
	});

	test('gives every unit a counterpart of its kind, and every id once', () => {
		for (const one of UNITS) {
			expect(findUnit(one.counterpart)?.kind, one.id).toBe(one.kind);
		}
		expect(new Set(UNITS.map((one) => one.id)).size).toBe(UNITS.length);
	});
});
