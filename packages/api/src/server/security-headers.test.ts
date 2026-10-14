import {afterAll, beforeEach, describe, expect, mock, test} from 'bun:test';
import type {Server} from 'node:http';
import type {AddressInfo} from 'node:net';

const mockEnv: {NODE_ENV: string; APP_URL: string} = {NODE_ENV: 'test', APP_URL: 'https://app.example.com'};

mock.module('../utils/env', () => ({env: mockEnv}));

const servers: Server[] = [];

// The whole app without a web app build, as the api alone is served in development.
async function start(): Promise<string> {
	const {createHttpApp} = await import('./create-http-app');
	const server = createHttpApp({webDist: '/nonexistent'}).listen(0);
	servers.push(server);
	return `http://localhost:${(server.address() as AddressInfo).port}`;
}

beforeEach(() => {
	mockEnv.APP_URL = 'https://app.example.com';
});

afterAll(() => {
	for (const server of servers) {
		server.close();
	}
});

describe('security headers', () => {
	test("on the api's answers, its errors and its 404s, without saying it runs Express", async () => {
		const base = await start();
		for (const path of ['/health', '/auth/methods', '/api/me', '/nope']) {
			const res = await fetch(`${base}${path}`);
			expect(res.headers.get('x-content-type-options')).toBe('nosniff');
			expect(res.headers.get('referrer-policy')).toBe('strict-origin-when-cross-origin');
			expect(res.headers.get('x-frame-options')).toBe('DENY');
			expect(res.headers.get('content-security-policy')).toBe("frame-ancestors 'none'");
			expect(res.headers.get('strict-transport-security')).toBe('max-age=31536000');
			expect(res.headers.get('x-powered-by')).toBeNull();
		}
	});

	test('no HSTS where Personal Agent Proxy is served over plain HTTP', async () => {
		mockEnv.APP_URL = 'http://localhost';
		const base = await start();
		const res = await fetch(`${base}/health`);
		expect(res.headers.get('strict-transport-security')).toBeNull();
		expect(res.headers.get('x-content-type-options')).toBe('nosniff');
	});
});
