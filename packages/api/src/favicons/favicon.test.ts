import {afterAll, beforeEach, describe, expect, mock, spyOn, test} from 'bun:test';

const env = {NODE_ENV: 'production', APP_URL: 'https://app.example.com', ALLOW_PRIVATE_HOSTS: false};

mock.module('../utils/env', () => ({env}));

// What the hosts resolve to: the example sites on the internet, one name on this machine's network.
const ADDRESSES: Record<string, string> = {
	'example.com': '93.184.216.34',
	'www.example.com': '93.184.216.34',
	'cdn.example.com': '93.184.216.35',
	'plain.dev': '93.184.216.36',
	'empty.dev': '93.184.216.37',
	'inside.dev': '93.184.216.38',
	'metadata.internal.dev': '169.254.169.254',
};

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

const sites = {requests: [] as string[], answers: new Map<string, () => Response>()};

const fetchSpy = spyOn(globalThis, 'fetch').mockImplementation((async (input: string | URL | Request) => {
	const url = String(input);
	sites.requests.push(url);
	return sites.answers.get(url)?.() ?? new Response('Not found', {status: 404});
}) as typeof fetch);

afterAll(() => {
	fetchSpy.mockRestore();
});

beforeEach(() => {
	sites.requests = [];
	sites.answers = new Map();
});

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
const SVG = '<svg xmlns="http://www.w3.org/2000/svg"/>';

function html(body: string): () => Response {
	return () => new Response(body, {headers: {'content-type': 'text/html'}});
}

function image(bytes: BodyInit, type: string): () => Response {
	return () => new Response(bytes, {headers: {'content-type': type}});
}

describe('mainDomain', () => {
	test('is the domain registered under the public suffix, none for an address or localhost', async () => {
		const {mainDomain} = await import('./favicon');

		expect(mainDomain('mcp.sentry.dev')).toBe('sentry.dev');
		expect(mainDomain('api.acme.co.uk')).toBe('acme.co.uk');
		expect(mainDomain('tools.my-server.vercel.app')).toBe('my-server.vercel.app');
		expect(mainDomain('127.0.0.1')).toBeNull();
		expect(mainDomain('localhost')).toBeNull();
	});
});

describe('iconLinks', () => {
	test('lists the icons a page names, a drawing first, then the larger pictures, an Apple touch icon last', async () => {
		const {iconLinks} = await import('./favicon');
		const page = `
			<link rel="apple-touch-icon" href="/apple.png">
			<link rel="icon" sizes="16x16" href="/16.png">
			<link href='/64.png' rel='shortcut icon' sizes='64x64'>
			<link rel="stylesheet" href="/site.css">
			<link rel="icon" type="image/svg+xml" href="https://cdn.example.com/mark.svg?v=1&amp;t=2">
			<link rel="icon" href="data:image/png;base64,AAAA">
		`;

		expect(iconLinks(page, new URL('https://www.example.com/')).map(String)).toEqual([
			'https://cdn.example.com/mark.svg?v=1&t=2',
			'https://www.example.com/64.png',
			'https://www.example.com/16.png',
			'https://www.example.com/apple.png',
		]);
	});
});

describe('faviconOf', () => {
	test('is the icon the home page names, after its redirect, kept for the next ask', async () => {
		const {faviconOf} = await import('./favicon');
		sites.answers.set('https://example.com/', () => new Response(null, {status: 301, headers: {location: 'https://www.example.com/'}}));
		sites.answers.set('https://www.example.com/', html('<link rel="icon" href="https://cdn.example.com/mark.svg">'));
		sites.answers.set('https://cdn.example.com/mark.svg', image(SVG, 'image/svg+xml'));

		const favicon = await faviconOf('example.com');
		expect(favicon?.type).toBe('image/svg+xml');
		expect(new TextDecoder().decode(favicon?.bytes)).toBe(SVG);

		await faviconOf('example.com');
		expect(sites.requests).toEqual(['https://example.com/', 'https://www.example.com/', 'https://cdn.example.com/mark.svg']);
	});

	test('is /favicon.ico where the page names none, or none that loads as an image', async () => {
		const {faviconOf} = await import('./favicon');
		sites.answers.set('https://plain.dev/', html('<link rel="icon" href="/broken.png">'));
		sites.answers.set('https://plain.dev/broken.png', html('Not an image'));
		sites.answers.set('https://plain.dev/favicon.ico', image(PNG, 'image/x-icon'));

		expect((await faviconOf('plain.dev'))?.type).toBe('image/x-icon');
	});

	test('is none where the site has no icon', async () => {
		const {faviconOf} = await import('./favicon');
		sites.answers.set('https://empty.dev/', html('<title>Nothing here</title>'));

		expect(await faviconOf('empty.dev')).toBeNull();
	});

	test("doesn't follow a redirect, or an icon, to a private address", async () => {
		const {faviconOf} = await import('./favicon');
		sites.answers.set('https://inside.dev/', html('<link rel="icon" href="https://metadata.internal.dev/icon.png">'));
		sites.answers.set('https://inside.dev/favicon.ico', () => new Response(null, {status: 302, headers: {location: 'https://metadata.internal.dev/favicon.ico'}}));
		sites.answers.set('https://metadata.internal.dev/icon.png', image(PNG, 'image/png'));
		sites.answers.set('https://metadata.internal.dev/favicon.ico', image(PNG, 'image/png'));

		expect(await faviconOf('inside.dev')).toBeNull();
		expect(sites.requests).toEqual(['https://inside.dev/', 'https://inside.dev/favicon.ico']);
	});
});
