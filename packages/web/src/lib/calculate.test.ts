/// <reference types="bun" />

import {describe, expect, test} from 'bun:test';
import {calculate, formatNumber} from '@/lib/calculate';

describe('calculate', () => {
	test('works out arithmetic in the usual order', () => {
		expect(calculate('2 + 3 * 4')).toBe(14);
		expect(calculate('(2 + 3) * 4')).toBe(20);
		expect(calculate('2 ^ 3 ^ 2')).toBe(512);
		expect(calculate('-2 ^ 2')).toBe(-4);
		expect(calculate('10 / 4 - 1')).toBe(1.5);
		expect(calculate('6 × 7 ÷ 2')).toBe(21);
		expect(calculate('1.5e3 + .5')).toBe(1500.5);
	});

	test('reads percent, factorials, constants and functions', () => {
		expect(calculate('18% * 86.40')).toBeCloseTo(15.552, 6);
		expect(calculate('340 * (1 + 15%)')).toBeCloseTo(391, 6);
		expect(calculate('5!')).toBe(120);
		expect(calculate('sqrt(2) * pi')).toBeCloseTo(4.44288, 5);
		expect(calculate('max(3, 9, 4) + log(1000)')).toBe(12);
		expect(calculate('round(2.5) + abs(-1)')).toBe(4);
	});

	test('reads nothing that is not a calculation, nor a result that is not a number', () => {
		for (const text of [
			'',
			'alert(1)',
			'2 +',
			'(1 + 2',
			'1 / 0',
			'sqrt 4',
			'2 3',
			'drop table',
			'1; 2',
		]) {
			expect(calculate(text), text).toBeNull();
		}
	});

	test('shows a result without floating point noise', () => {
		expect(formatNumber(0.1 + 0.2)).toBe(formatNumber(0.3));
	});
});
