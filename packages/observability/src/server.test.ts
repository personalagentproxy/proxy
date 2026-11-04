import {afterEach, beforeEach, describe, expect, it, mock, spyOn} from 'bun:test';

import {createServerLogger} from './server';

const lokiConfig = {url: 'http://loki.test', userId: 'u', token: 't'};

type Push = {streams: Array<{stream: Record<string, string>; values: Array<[string, string]>}>};

function linesOf(pushes: Push[]): string[] {
	return pushes.flatMap((push) => push.streams.flatMap((s) => s.values.map(([, line]) => line)));
}

// Bun's fetch carries `preconnect`, so a stub borrows the real one to stand in for it.
function stubFetch(impl: (input: string | URL | Request, init?: RequestInit) => Promise<Response>) {
	return spyOn(globalThis, 'fetch').mockImplementation(
		Object.assign(impl, {preconnect: fetch.preconnect}),
	);
}

function capturingFetch(pushes: Push[], status = 204) {
	return stubFetch(async (_url, init) => {
		if (typeof init?.body === 'string') {
			pushes.push(JSON.parse(init.body) as Push);
		}
		return new Response(null, {status});
	});
}

describe('createServerLogger', () => {
	let logs: unknown[][];
	let errors: unknown[][];

	beforeEach(() => {
		logs = [];
		errors = [];
		spyOn(console, 'log').mockImplementation((...args) => void logs.push(args));
		spyOn(console, 'warn').mockImplementation(() => {});
		spyOn(console, 'error').mockImplementation((...args) => void errors.push(args));
	});

	afterEach(() => {
		mock.restore();
	});

	it('writes stdout alone when there is no Loki address', async () => {
		const fetchSpy = stubFetch(async () => new Response(null, {status: 204}));
		const log = createServerLogger({
			loki: {url: '', userId: '', token: ''},
			service: 'api',
			env: 'production',
		});
		log.info('hello', {a: 1});
		await log.flush();
		expect(fetchSpy).not.toHaveBeenCalled();
		expect(logs).toHaveLength(1);
		const line = JSON.parse(String(logs[0]?.[0])) as Record<string, unknown>;
		expect(line).toMatchObject({level: 'info', service: 'api', msg: 'hello', a: 1});
		expect(typeof line.ts).toBe('string');
		await log.shutdown();
	});

	it('keeps the fixed fields of a JSON line over context named like them', async () => {
		const log = createServerLogger({
			loki: {url: '', userId: '', token: ''},
			service: 'api',
			env: 'production',
		});
		log.info('real', {msg: 'fake', level: 'error'});
		const line = JSON.parse(String(logs[0]?.[0])) as Record<string, unknown>;
		expect(line.msg).toBe('real');
		expect(line.level).toBe('info');
		await log.shutdown();
	});

	it('writes text in development, and debug lines too', async () => {
		const log = createServerLogger({
			loki: {url: '', userId: '', token: ''},
			service: 'api',
			env: 'development',
		});
		log.debug('fine', {n: 2});
		expect(logs[0]).toEqual(['[api] DEBUG', 'fine', {n: 2}]);
		await log.shutdown();
	});

	it('drops debug lines in production', async () => {
		const log = createServerLogger({
			loki: {url: '', userId: '', token: ''},
			service: 'api',
			env: 'production',
		});
		log.debug('fine');
		expect(logs).toHaveLength(0);
		await log.shutdown();
	});

	it('pushes lines to Loki by level, with the context and the message as the line', async () => {
		const pushes: Push[] = [];
		capturingFetch(pushes);
		const log = createServerLogger({
			loki: lokiConfig,
			service: 'api',
			env: 'production',
			stdout: 'off',
			flushIntervalMs: 1_000_000,
		});
		log.info('one', {a: 1});
		log.error('two');
		await log.flush();
		expect(pushes).toHaveLength(1);
		const streams = pushes[0]!.streams;
		expect(streams.map((s) => s.stream)).toEqual([
			{service: 'api', env: 'production', level: 'info'},
			{service: 'api', env: 'production', level: 'error'},
		]);
		expect(linesOf(pushes)).toEqual([
			JSON.stringify({a: 1, msg: 'one'}),
			JSON.stringify({msg: 'two'}),
		]);
		expect(logs).toHaveLength(0);
		await log.shutdown();
	});

	it('adds ambient and child context, the line’s own winning', async () => {
		const pushes: Push[] = [];
		capturingFetch(pushes);
		const log = createServerLogger({
			loki: lokiConfig,
			service: 'api',
			env: 'production',
			stdout: 'off',
			flushIntervalMs: 1_000_000,
			getAmbientContext: () => ({requestId: 'r1', userId: 'ambient'}),
		});
		log.child({source: 'db'}).warn('slow', {userId: 'own'});
		await log.flush();
		expect(JSON.parse(linesOf(pushes)[0]!)).toEqual({
			requestId: 'r1',
			userId: 'own',
			source: 'db',
			msg: 'slow',
		});
		await log.shutdown();
	});

	it('expands errors in the context', async () => {
		const pushes: Push[] = [];
		capturingFetch(pushes);
		const log = createServerLogger({
			loki: lokiConfig,
			service: 'api',
			env: 'production',
			stdout: 'off',
			flushIntervalMs: 1_000_000,
		});
		log.error('failed', {cause: new Error('boom')});
		await log.flush();
		const line = JSON.parse(linesOf(pushes)[0]!) as {cause: {message: string}};
		expect(line.cause.message).toBe('boom');
		await log.shutdown();
	});

	it('flushes when the buffer is full', async () => {
		const pushes: Push[] = [];
		capturingFetch(pushes);
		const log = createServerLogger({
			loki: lokiConfig,
			service: 'api',
			env: 'production',
			stdout: 'off',
			maxBufferSize: 2,
			flushIntervalMs: 1_000_000,
		});
		log.info('a');
		log.info('b');
		await log.flush();
		expect(linesOf(pushes)).toHaveLength(2);
		await log.shutdown();
	});

	it('keeps lines for the next flush when a push fails, the newest when over the cap', async () => {
		const pushes: Push[] = [];
		capturingFetch(pushes, 500);
		// maxBufferSize 2 keeps 40 lines at most.
		const log = createServerLogger({
			loki: lokiConfig,
			service: 'api',
			env: 'production',
			stdout: 'off',
			maxBufferSize: 2,
			flushIntervalMs: 1_000_000,
		});
		for (let i = 0; i < 50; i++) {
			log.info(`m${i}`);
		}
		await log.flush();
		expect(errors.length).toBeGreaterThan(0);

		pushes.length = 0;
		mock.restore();
		spyOn(console, 'error').mockImplementation(() => {});
		capturingFetch(pushes);
		await log.flush();
		const lines = linesOf(pushes).map((line) => (JSON.parse(line) as {msg: string}).msg);
		expect(lines).toHaveLength(40);
		expect(lines[0]).toBe('m10');
		expect(lines[39]).toBe('m49');
		await log.shutdown();
	});

	it('pushes what is left on shutdown and writes stdout alone after', async () => {
		const pushes: Push[] = [];
		capturingFetch(pushes);
		const log = createServerLogger({
			loki: lokiConfig,
			service: 'api',
			env: 'production',
			flushIntervalMs: 1_000_000,
		});
		log.info('before');
		await log.shutdown();
		expect(linesOf(pushes)).toHaveLength(1);
		log.info('after');
		await log.flush();
		expect(linesOf(pushes)).toHaveLength(1);
		expect(logs).toHaveLength(2);
	});
});
