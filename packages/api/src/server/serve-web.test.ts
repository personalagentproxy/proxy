import {afterAll, beforeAll, describe, expect, test} from 'bun:test';
import {mkdirSync, mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import type {Server} from 'node:http';
import type {AddressInfo} from 'node:net';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

import express from 'express';

import {serveWeb} from './serve-web';

const dir = mkdtempSync(join(tmpdir(), 'proxy-web-'));
let server: Server;
let base: string;

beforeAll(() => {
	mkdirSync(join(dir, 'assets'));
	writeFileSync(join(dir, 'index.html'), '<!doctype html><title>Proxy</title>');
	writeFileSync(join(dir, 'favicon.svg'), '<svg/>');
	writeFileSync(join(dir, 'assets', 'index-abc.js'), 'console.log(1)');

	// Laid out like createHttpApp: an api route, the web app, then the api's 404.
	const app = express();
	app.get('/api/me', (_req, res) => {
		res.json({me: true});
	});
	app.use(serveWeb(dir));
	app.use((_req, res) => {
		res.status(404).json({error: 'not_found'});
	});
	server = app.listen(0);
	base = `http://localhost:${(server.address() as AddressInfo).port}`;
});

afterAll(() => {
	server.close();
	rmSync(dir, {recursive: true});
});

describe('serveWeb', () => {
	test("serves the app's page for its routes, revalidated on every load", async () => {
		for (const path of ['/', '/connections', '/agent/info/addresses']) {
			const res = await fetch(`${base}${path}`);
			expect(res.status).toBe(200);
			expect(res.headers.get('cache-control')).toBe('no-cache');
			expect(await res.text()).toContain('<title>Proxy</title>');
		}
	});

	test('serves files, and hashed assets cached for good', async () => {
		expect(await (await fetch(`${base}/favicon.svg`)).text()).toBe('<svg/>');

		const asset = await fetch(`${base}/assets/index-abc.js`);
		expect(asset.status).toBe(200);
		expect(asset.headers.get('cache-control')).toContain('immutable');
	});

	test('a missing asset is a 404, not the page', async () => {
		expect((await fetch(`${base}/assets/gone.js`)).status).toBe(404);
	});

	test("leaves the api's paths to the api", async () => {
		expect(await (await fetch(`${base}/api/me`)).json()).toEqual({me: true});

		for (const path of ['/api/nope', '/auth/nope', '/agent-auth/nope']) {
			const res = await fetch(`${base}${path}`);
			expect(res.status).toBe(404);
			expect(await res.json()).toEqual({error: 'not_found'});
		}
	});
});
