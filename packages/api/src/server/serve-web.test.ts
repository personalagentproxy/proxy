import {afterAll, beforeAll, describe, expect, mock, test} from 'bun:test';
import {mkdirSync, mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import type {Server} from 'node:http';
import type {AddressInfo} from 'node:net';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

mock.module('../utils/env', () => ({env: {NODE_ENV: 'test', APP_URL: 'http://localhost'}}));

const dir = mkdtempSync(join(tmpdir(), 'proxy-web-'));
const servers: Server[] = [];

// The whole app, as index.ts serves it, with `webDist` as its web app's build.
async function start(webDist: string): Promise<string> {
	const {createHttpApp} = await import('./create-http-app');
	const server = createHttpApp({webDist}).listen(0);
	servers.push(server);
	return `http://localhost:${(server.address() as AddressInfo).port}`;
}

let base: string;

beforeAll(async () => {
	mkdirSync(join(dir, 'assets'));
	writeFileSync(join(dir, 'index.html'), '<!doctype html><title>Personal Agent Proxy</title>');
	writeFileSync(join(dir, 'favicon.svg'), '<svg/>');
	writeFileSync(join(dir, 'assets', 'index-abc.js'), 'console.log(1)');
	base = await start(dir);
});

afterAll(() => {
	for (const server of servers) {
		server.close();
	}
	rmSync(dir, {recursive: true});
});

describe('the web app on the api origin', () => {
	test("serves the app's page for its routes, revalidated on every load", async () => {
		for (const path of ['/', '/connections', '/agent/info/addresses']) {
			const res = await fetch(`${base}${path}`);
			expect(res.status).toBe(200);
			expect(res.headers.get('cache-control')).toBe('no-cache');
			expect(res.headers.get('x-content-type-options')).toBe('nosniff');
			expect(res.headers.get('referrer-policy')).toBe('strict-origin-when-cross-origin');
			expect(res.headers.get('x-frame-options')).toBe('SAMEORIGIN');
			expect(await res.text()).toContain('<title>Personal Agent Proxy</title>');
		}
	});

	test('serves files, and hashed assets cached for good', async () => {
		expect(await (await fetch(`${base}/favicon.svg`)).text()).toBe('<svg/>');

		const asset = await fetch(`${base}/assets/index-abc.js`);
		expect(asset.status).toBe(200);
		expect(asset.headers.get('cache-control')).toContain('immutable');
		expect(asset.headers.get('x-frame-options')).toBe('SAMEORIGIN');
	});

	test('a missing asset is a 404, not the page', async () => {
		expect((await fetch(`${base}/assets/gone.js`)).status).toBe(404);
	});

	test("leaves the api's paths to the api, with or without a trailing slash", async () => {
		expect(await (await fetch(`${base}/health`)).json()).toEqual({ok: true});
		expect(await (await fetch(`${base}/auth/methods`)).json()).toEqual({google: false});

		for (const path of ['/api', '/api/nope', '/auth', '/auth/nope', '/agent-auth', '/agent-auth/nope']) {
			const res = await fetch(`${base}${path}`);
			expect(res.status).toBe(404);
			expect(await res.json()).toEqual({error: 'not_found'});
		}
	});
});

describe('without a web app build', () => {
	test('only the api is served', async () => {
		const apiOnly = await start(join(dir, 'no-build-here'));
		const res = await fetch(`${apiOnly}/connections`);

		expect(res.status).toBe(404);
		expect(await res.json()).toEqual({error: 'not_found'});
	});
});
