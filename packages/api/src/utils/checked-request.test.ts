import {afterAll, beforeEach, describe, expect, mock, spyOn, test} from 'bun:test';
import {z} from 'zod';

const env = {ALLOW_PRIVATE_HOSTS: false};

mock.module('./env', () => ({env}));

const ADDRESSES: Record<string, string> = {'mcp.example.com': '93.184.216.34', 'internal.example.com': '10.0.0.5'};

mock.module('node:dns/promises', () => ({
	default: {
		lookup: async (host: string) => {
			const address = ADDRESSES[host];
			if (!address) {
				throw new Error(`ENOTFOUND ${host}`);
			}
			return [{address, family: 4}];
		},
	},
}));

const requests: Array<{url: string; redirect?: RequestRedirect}> = [];

const fetchSpy = spyOn(globalThis, 'fetch').mockImplementation((async (input: string | URL | Request, init?: RequestInit) => {
	requests.push({url: String(input), redirect: init?.redirect});
	return Response.json({ok: true});
}) as typeof fetch);

afterAll(() => {
	fetchSpy.mockRestore();
});

beforeEach(() => {
	requests.length = 0;
	env.ALLOW_PRIVATE_HOSTS = false;
});

describe('checkedRequest', () => {
	test('makes the request to a public https address, never following a redirect', async () => {
		const {checkedRequest} = await import('./checked-request');
		expect((await checkedRequest('https://mcp.example.com/mcp', {method: 'POST'}, {schema: z.object({ok: z.boolean()})})).unwrap()).toEqual({ok: true});
		expect(requests).toEqual([{url: 'https://mcp.example.com/mcp', redirect: 'error'}]);
	});

	test('refuses, without a request, an address on a private network, one that resolves to one, http to the internet, and what is no address', async () => {
		const {checkedRequest} = await import('./checked-request');
		for (const url of ['http://169.254.169.254/latest/api/token', 'https://internal.example.com/token', 'http://mcp.example.com/mcp', 'not a url']) {
			const refused = (await checkedRequest(url, {}, {parse: 'response'})).unwrapErr();
			expect(refused.kind, url).toBe('network');
		}
		expect(requests).toHaveLength(0);
	});

	test('reaches a private address, over http too, where ALLOW_PRIVATE_HOSTS allows it', async () => {
		const {checkedRequest} = await import('./checked-request');
		env.ALLOW_PRIVATE_HOSTS = true;
		(await checkedRequest('http://internal.example.com/mcp', {}, {})).unwrap();
		expect(requests).toEqual([{url: 'http://internal.example.com/mcp', redirect: 'error'}]);
	});
});
