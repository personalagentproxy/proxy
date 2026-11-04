import {afterEach, describe, expect, it, mock, spyOn} from 'bun:test';

import {createClientLogger} from './client';
import type {ClientLogBatch} from './types';

function stubFetch(impl: (input: string | URL | Request, init?: RequestInit) => Promise<Response>) {
	return spyOn(globalThis, 'fetch').mockImplementation(
		Object.assign(impl, {preconnect: fetch.preconnect}),
	);
}

function capturing(batches: ClientLogBatch[], status = 204) {
	return stubFetch(async (_url, init) => {
		if (typeof init?.body === 'string') {
			batches.push(JSON.parse(init.body) as ClientLogBatch);
		}
		return new Response(null, {status});
	});
}

afterEach(() => {
	mock.restore();
});

describe('createClientLogger', () => {
	it('posts batches to the endpoint with the session’s cookies', async () => {
		const batches: ClientLogBatch[] = [];
		const fetchSpy = capturing(batches);
		const log = createClientLogger({endpoint: '/api/client-logs', env: 'production'});
		log.child({page: 'home'}).error('broke', {kind: 'x'});
		await log.flush();
		expect(fetchSpy.mock.calls[0]?.[0]).toBe('/api/client-logs');
		expect(fetchSpy.mock.calls[0]?.[1]).toMatchObject({
			method: 'POST',
			credentials: 'include',
			keepalive: true,
		});
		expect(batches[0]?.entries).toEqual([
			{ts: expect.any(Number), level: 'error', msg: 'broke', ctx: {page: 'home', kind: 'x'}},
		]);
	});

	it('posts nothing without an endpoint, and echoes in development', async () => {
		const fetchSpy = stubFetch(async () => new Response(null, {status: 204}));
		const warn = spyOn(console, 'warn').mockImplementation(() => {});
		const log = createClientLogger({endpoint: '', env: 'development'});
		log.warn('hm');
		await log.flush();
		expect(fetchSpy).not.toHaveBeenCalled();
		expect(warn).toHaveBeenCalledWith('[client] WARN', 'hm', {});
	});

	it('drops a batch the api refuses and keeps one it cannot take', async () => {
		const batches: ClientLogBatch[] = [];
		capturing(batches, 400);
		const log = createClientLogger({endpoint: '/api/client-logs', env: 'production'});
		log.info('refused');
		await log.flush();
		mock.restore();
		capturing(batches, 503);
		log.info('kept');
		await log.flush();
		mock.restore();
		capturing(batches);
		await log.flush();
		expect(batches.map((b) => b.entries.map((e) => e.msg))).toEqual([
			['refused'],
			['kept'],
			['kept'],
		]);
	});

	it('flushes when the batch is full', async () => {
		const batches: ClientLogBatch[] = [];
		capturing(batches);
		const log = createClientLogger({
			endpoint: '/api/client-logs',
			env: 'production',
			maxBatchSize: 2,
		});
		log.info('a');
		log.info('b');
		await log.flush();
		expect(batches[0]?.entries).toHaveLength(2);
	});
});
