/// <reference types="bun" />

import {describe, expect, test} from 'bun:test';
import {
	FACING,
	FIRST_HOVER_FOLLOW_TIME_MS,
	FOLLOW_TIME_MS,
	followAmount,
	followTime,
	poseTowardPointer,
} from '@/lib/head';

const bounds = {left: 100, top: 200, width: 40, height: 40};

describe('poseTowardPointer', () => {
	test('faces forward at the center of the head', () => {
		const pose = poseTowardPointer({x: 120, y: 220}, bounds);
		expect(pose.rotX).toBe(FACING.rotX);
		expect(pose.rotY).toBe(FACING.rotY);
		expect(pose.rotZ).toBeCloseTo(FACING.rotZ);
	});

	test('uses the full turn and nod range at the edges of the hovered head', () => {
		expect(poseTowardPointer({x: 100, y: 220}, bounds)).toEqual({
			rotX: 0,
			rotY: -135,
			rotZ: 10,
		});
		expect(poseTowardPointer({x: 140, y: 220}, bounds)).toEqual({
			rotX: 0,
			rotY: -45,
			rotZ: -10,
		});
		expect(poseTowardPointer({x: 120, y: 200}, bounds).rotX).toBe(-30);
		expect(poseTowardPointer({x: 120, y: 240}, bounds).rotX).toBe(30);
	});

	test('clamps pointers beyond the head to the same range', () => {
		expect(poseTowardPointer({x: 500, y: -500}, bounds)).toEqual({
			rotX: -30,
			rotY: -45,
			rotZ: -10,
		});
	});

	test('can use a larger tracking range while keeping the head as its origin', () => {
		expect(poseTowardPointer({x: 140, y: 240}, bounds, {width: 400, height: 400})).toEqual({
			rotX: 3,
			rotY: -85.5,
			rotZ: -1,
		});
	});
});

describe('followAmount', () => {
	test('moves more gently during the first hover than during ordinary tracking', () => {
		const frame = 1000 / 60;
		expect(followAmount(frame, FIRST_HOVER_FOLLOW_TIME_MS)).toBeLessThan(
			followAmount(frame, FOLLOW_TIME_MS),
		);
	});

	test('travels the same distance over time at different refresh rates', () => {
		const at60Fps = 1 - (1 - followAmount(1000 / 60, FOLLOW_TIME_MS)) ** 60;
		const at120Fps = 1 - (1 - followAmount(1000 / 120, FOLLOW_TIME_MS)) ** 120;
		expect(at60Fps).toBeCloseTo(at120Fps, 10);
	});

	test('uses gentler timing only before the first-hover cutoff', () => {
		expect(followTime(true, 599, 600)).toBe(FIRST_HOVER_FOLLOW_TIME_MS);
		expect(followTime(true, 600, 600)).toBe(FOLLOW_TIME_MS);
		expect(followTime(false, 599, 600)).toBe(FOLLOW_TIME_MS);
	});
});
