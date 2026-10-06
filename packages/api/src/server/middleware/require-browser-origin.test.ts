import {beforeEach, describe, expect, mock, test} from 'bun:test';

// The allowed origin is read once, when the middleware module loads.
const mockEnv: {APP_URL: string | undefined} = {APP_URL: 'https://app.example.com'};

mock.module('../../utils/env', () => ({env: mockEnv}));

function makeRes() {
	const res = {
		statusCode: 0,
		body: undefined as {error: string} | undefined,
		status(code: number) {
			res.statusCode = code;
			return res;
		},
		json(payload: {error: string}) {
			res.body = payload;
			return res;
		},
	};
	return res;
}

async function run(method: string, origin: string | undefined) {
	const {requireBrowserOrigin} = await import('./require-browser-origin');
	const req = {method, headers: origin === undefined ? {} : {origin}};
	const res = makeRes();
	const next = mock();
	requireBrowserOrigin(req as never, res as never, next);
	return {res, next};
}

beforeEach(() => {
	mockEnv.APP_URL = 'https://app.example.com';
});

describe('requireBrowserOrigin', () => {
	test('passes a state-changing request from the app origin', async () => {
		const {res, next} = await run('POST', 'https://app.example.com');
		expect(next).toHaveBeenCalledTimes(1);
		expect(res.statusCode).toBe(0);
	});

	test('rejects a state-changing request from a foreign origin', async () => {
		const {res, next} = await run('POST', 'https://evil.example');
		expect(next).not.toHaveBeenCalled();
		expect(res.statusCode).toBe(403);
		expect(res.body).toEqual({error: 'forbidden_origin'});
	});

	test('rejects a state-changing request with no Origin header (cross-site form post)', async () => {
		const {res, next} = await run('DELETE', undefined);
		expect(next).not.toHaveBeenCalled();
		expect(res.statusCode).toBe(403);
	});

	test('does not let a look-alike subdomain through', async () => {
		const {res, next} = await run('POST', 'https://app.example.com.evil.example');
		expect(next).not.toHaveBeenCalled();
		expect(res.statusCode).toBe(403);
	});

	test('lets safe methods through regardless of Origin', async () => {
		for (const method of ['GET', 'HEAD', 'OPTIONS']) {
			const {res, next} = await run(method, 'https://evil.example');
			expect(next).toHaveBeenCalledTimes(1);
			expect(res.statusCode).toBe(0);
		}
	});

	test('without APP_URL there is nothing to enforce: every request passes', async () => {
		mockEnv.APP_URL = undefined;
		// A fresh copy of the module, so it reads the unset APP_URL at load.
		const specifier = './require-browser-origin?unconfigured';
		const {requireBrowserOrigin}: typeof import('./require-browser-origin') = await import(specifier);

		const res = makeRes();
		const next = mock();
		requireBrowserOrigin({method: 'POST', headers: {origin: 'https://evil.example'}} as never, res as never, next);

		expect(next).toHaveBeenCalledTimes(1);
		expect(res.statusCode).toBe(0);
	});
});
