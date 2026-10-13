/// <reference types="bun" />
import {describe, expect, test} from 'bun:test';
import {readFile} from 'node:fs/promises';
import {BUTTON_EDGES} from './button-edges';
import {routePaths, WEB_ROUTER_FILE} from './router-paths';

describe('button edges', () => {
	test('join screens the web app routes', async () => {
		const paths = new Set(routePaths(await readFile(WEB_ROUTER_FILE, 'utf8')));
		expect(paths.size).toBeGreaterThan(10);
		for (const edge of BUTTON_EDGES) {
			expect(paths).toContain(edge.from);
			expect(paths).toContain(edge.to);
		}
	});

	test('are listed once', () => {
		const keys = BUTTON_EDGES.map((edge) => `${edge.from} ${edge.to} ${edge.label}`);
		expect(new Set(keys).size).toBe(keys.length);
	});
});
