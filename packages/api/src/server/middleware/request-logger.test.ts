import {afterEach, beforeEach, describe, expect, it, mock} from 'bun:test';
import express from 'express';
import type {Server} from 'node:http';

const lines: Array<{msg: string; ctx: Record<string, unknown> | undefined}> = [];

mock.module('../../observability/log', () => ({
	log: {
		debug: mock(),
		info: mock((msg: string, ctx?: Record<string, unknown>) => void lines.push({msg, ctx})),
		warn: mock(),
		error: mock(),
	},
	serializeError: mock(() => ({})),
}));

const {requestLogger} = await import('./request-logger');
const {addContext, getContext} = await import('../../observability/request-context');

let server: Server;
let base: string;

beforeEach(() => {
	lines.length = 0;
	const app = express();
	app.use(requestLogger);
	app.get('/things/:id', (req, res) => {
		addContext({userId: 'u1'});
		res.json({id: req.params.id, ctx: getContext()});
	});
	app.put('/api/blobs/:token', (_req, res) => {
		res.json({ctx: getContext()});
	});
	app.get('/fail', (_req, res) => {
		res.status(500).end();
	});
	server = app.listen(0);
	const address = server.address();
	base = `http://localhost:${typeof address === 'object' && address ? address.port : 0}`;
});

afterEach(() => {
	server.close();
});

describe('requestLogger', () => {
	it('answers with a request id and writes one line with the matched route when done', async () => {
		const response = await fetch(`${base}/things/42`);
		const requestId = response.headers.get('x-request-id');
		expect(requestId).toMatch(/^[0-9a-f-]{36}$/);
		const body = (await response.json()) as {id: string; ctx: Record<string, unknown>};
		expect(body.ctx).toEqual({requestId, method: 'GET', path: '/things/42', userId: 'u1'});
		expect(lines).toEqual([{msg: 'request finished', ctx: {status: 200, durationMs: expect.any(Number), aborted: false, route: '/things/:id'}}]);
	});

	it('never writes a blob’s token, which is its URL’s credential', async () => {
		const response = await fetch(`${base}/api/blobs/the-token`, {method: 'PUT', body: 'bytes'});
		const body = (await response.json()) as {ctx: Record<string, unknown>};
		expect(body.ctx.path).toBe('/api/blobs/:token');
		expect(JSON.stringify(lines)).not.toContain('the-token');
		expect(lines[0]?.ctx).toMatchObject({route: '/api/blobs/:token'});
	});

	it('keeps a request id the caller sent', async () => {
		const response = await fetch(`${base}/fail`, {headers: {'x-request-id': 'given-by-caller'}});
		expect(response.headers.get('x-request-id')).toBe('given-by-caller');
		expect(lines[0]?.ctx).toMatchObject({status: 500, route: '/fail'});
	});
});
