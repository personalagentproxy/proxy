import {describe, expect, test} from 'bun:test';
import {zoomPath} from './zoom-path';

const HOUR = 60 * 60 * 1000;

describe('zoomPath', () => {
	test('starts at the one view and ends at the other', () => {
		const path = zoomPath({center: 100 * HOUR, width: 24 * HOUR}, {center: 90 * HOUR, width: HOUR});
		expect(path(0).center).toBeCloseTo(100 * HOUR, 3);
		expect(path(0).width).toBeCloseTo(24 * HOUR, 3);
		expect(path(1).center).toBeCloseTo(90 * HOUR, 3);
		expect(path(1).width).toBeCloseTo(HOUR, 3);
	});

	test('zooming in on the middle keeps it still, the width shrinking by even factors', () => {
		const path = zoomPath({center: 50 * HOUR, width: 16 * HOUR}, {center: 50 * HOUR, width: HOUR});
		expect(path(0.5).center).toBe(50 * HOUR);
		expect(path(0.5).width).toBeCloseTo(4 * HOUR, 3);
	});

	test('between two views far apart, it zooms out on the way, and moves the middle the whole way', () => {
		const path = zoomPath({center: 0, width: HOUR}, {center: 200 * HOUR, width: HOUR});
		expect(path(0.5).width).toBeGreaterThan(HOUR);
		expect(path(0.5).center).toBeCloseTo(100 * HOUR, -3);
		const centers = [0, 0.25, 0.5, 0.75, 1].map((t) => path(t).center);
		expect([...centers].sort((a, b) => a - b)).toEqual(centers);
	});
});
