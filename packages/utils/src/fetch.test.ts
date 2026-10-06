import {afterEach, describe, expect, it, mock, spyOn} from 'bun:test';
import {z} from 'zod';

import {httpRequest, type FetchError} from './fetch';

function jsonResponse(body: unknown, init?: ResponseInit): Response {
	return new Response(JSON.stringify(body), {
		status: 200,
		headers: {'Content-Type': 'application/json'},
		...init,
	});
}

function textResponse(body: string, init?: ResponseInit): Response {
	return new Response(body, {status: 200, ...init});
}

// Bun's fetch carries `preconnect`, so a stub borrows the real one to stand in for it.
function stubFetch(
	impl: (input: string | URL | Request, init?: RequestInit) => Promise<Response>,
): void {
	spyOn(globalThis, 'fetch').mockImplementation(
		Object.assign(impl, {preconnect: fetch.preconnect}),
	);
}

afterEach(() => {
	mock.restore();
});

describe('httpRequest', () => {
	describe('success paths', () => {
		it('returns Ok(undefined) on 2xx with no schema or parse mode and cancels the body', async () => {
			const cancel = mock(async () => {});
			const response = jsonResponse({hello: 'world'});
			Object.defineProperty(response, 'body', {value: {cancel}});
			stubFetch(async () => response);

			const result = await httpRequest('https://api.test/x');

			expect(result.isOk()).toBe(true);
			expect(result.unwrap()).toBeUndefined();
			expect(cancel).toHaveBeenCalledTimes(1);
		});

		it('returns the schema-narrowed body when schema validates', async () => {
			stubFetch(async () => jsonResponse({id: 'abc', n: 7}));
			const schema = z.object({id: z.string(), n: z.number()});

			const result = await httpRequest('https://api.test/x', undefined, {schema});

			expect(result.isOk()).toBe(true);
			expect(result.unwrap()).toEqual({id: 'abc', n: 7});
		});

		it('parse: response returns the raw Response', async () => {
			const response = jsonResponse({});
			stubFetch(async () => response);

			const result = await httpRequest('https://api.test/x', undefined, {parse: 'response'});

			expect(result.isOk()).toBe(true);
			expect(result.unwrap()).toBe(response);
		});

		it('parse: text returns the body as a string', async () => {
			stubFetch(async () => textResponse('hello world'));

			const result = await httpRequest('https://api.test/x', undefined, {parse: 'text'});

			expect(result.isOk()).toBe(true);
			expect(result.unwrap()).toBe('hello world');
		});

		it('parse: arrayBuffer returns the body as an ArrayBuffer', async () => {
			stubFetch(async () => new Response(new Uint8Array([1, 2, 3]), {status: 200}));

			const result = await httpRequest('https://api.test/x', undefined, {parse: 'arrayBuffer'});

			expect(result.isOk()).toBe(true);
			const buf = result.unwrap();
			expect(buf).toBeInstanceOf(ArrayBuffer);
			expect(new Uint8Array(buf)).toEqual(new Uint8Array([1, 2, 3]));
		});
	});

	describe('schema error', () => {
		it('returns kind: schema with zod issues when validation fails', async () => {
			stubFetch(async () => jsonResponse({id: 1}));
			const schema = z.object({id: z.string()});

			const result = await httpRequest('https://api.test/x', undefined, {schema});

			expect(result.isErr()).toBe(true);
			const err = result.unwrapErr();
			expect(err.kind).toBe('schema');
			if (err.kind === 'schema') {
				expect(err.url).toBe('https://api.test/x');
				expect(err.issues.length).toBeGreaterThan(0);
			}
		});

		it('returns kind: parse when the response body is not valid JSON', async () => {
			stubFetch(async () => textResponse('not json'));
			const schema = z.object({id: z.string()});

			const result = await httpRequest('https://api.test/x', undefined, {schema});

			expect(result.isErr()).toBe(true);
			expect(result.unwrapErr().kind).toBe('parse');
		});
	});

	describe('http error', () => {
		it('parses JSON error bodies into FetchError.body', async () => {
			stubFetch(async () => jsonResponse({error: 'boom'}, {status: 500}));

			const result = await httpRequest('https://api.test/x');

			expect(result.isErr()).toBe(true);
			const err = result.unwrapErr();
			expect(err.kind).toBe('http');
			if (err.kind === 'http') {
				expect(err.status).toBe(500);
				expect(err.body).toEqual({error: 'boom'});
			}
		});

		it('falls back to the raw text when the error body is not JSON', async () => {
			stubFetch(async () => textResponse('rate limited', {status: 429}));

			const result = await httpRequest('https://api.test/x');

			const err = result.unwrapErr();
			expect(err.kind).toBe('http');
			if (err.kind === 'http') {
				expect(err.status).toBe(429);
				expect(err.body).toBe('rate limited');
			}
		});

		it('uses null when the error body is empty', async () => {
			stubFetch(async () => new Response('', {status: 503}));

			const result = await httpRequest('https://api.test/x');

			const err = result.unwrapErr();
			expect(err.kind).toBe('http');
			if (err.kind === 'http') {
				expect(err.body).toBeNull();
			}
		});

		it('allowStatus widens the success predicate (e.g. 304 → Ok)', async () => {
			const response = new Response(null, {status: 304});
			stubFetch(async () => response);

			const result = await httpRequest('https://api.test/x', undefined, {
				parse: 'response',
				allowStatus: (s) => s === 200 || s === 304,
			});

			expect(result.isOk()).toBe(true);
			expect(result.unwrap().status).toBe(304);
		});
	});

	describe('network and timeout', () => {
		it('returns kind: network when fetch throws', async () => {
			stubFetch(async () => {
				throw new TypeError('ENOTFOUND');
			});

			const result = await httpRequest('https://api.test/x');

			const err = result.unwrapErr();
			expect(err.kind).toBe('network');
			if (err.kind === 'network') {
				expect(err.url).toBe('https://api.test/x');
				expect((err.cause as Error).message).toBe('ENOTFOUND');
			}
		});

		it('returns kind: timeout when the timeout signal fires', async () => {
			stubFetch(async (_input, init) => {
				// Wait long enough for AbortSignal.timeout to fire.
				await new Promise<void>((_resolve, reject) => {
					const onAbort = (): void => {
						init?.signal?.removeEventListener('abort', onAbort);
						reject(new DOMException('aborted', 'AbortError'));
					};
					init?.signal?.addEventListener('abort', onAbort);
				});
				throw new Error('unreachable');
			});

			const result = await httpRequest('https://api.test/x', undefined, {timeoutMs: 5});

			const err = result.unwrapErr();
			expect(err.kind).toBe('timeout');
			if (err.kind === 'timeout') {
				expect(err.timeoutMs).toBe(5);
			}
		});

		it('distinguishes caller-abort from timeout', async () => {
			const callerAbort = new AbortController();
			stubFetch(async (_input, init) => {
				await new Promise<void>((_resolve, reject) => {
					const onAbort = (): void => {
						init?.signal?.removeEventListener('abort', onAbort);
						reject(new DOMException('aborted', 'AbortError'));
					};
					init?.signal?.addEventListener('abort', onAbort);
				});
				throw new Error('unreachable');
			});

			const pending = httpRequest(
				'https://api.test/x',
				{signal: callerAbort.signal},
				{timeoutMs: 10_000},
			);
			callerAbort.abort();
			const result = await pending;

			// Caller aborted before the timeout fired — should surface as network,
			// not timeout.
			expect(result.unwrapErr().kind).toBe('network');
		});
	});

	describe('url extraction', () => {
		it.each<[string, string | URL | Request]>([
			['string', 'https://api.test/from-string'],
			['URL', new URL('https://api.test/from-url')],
			['Request', new Request('https://api.test/from-request')],
		])('captures the url from %s input on error', async (_label, input) => {
			stubFetch(async () => {
				throw new Error('down');
			});

			const result = await httpRequest(input);

			const err = result.unwrapErr() as Extract<FetchError, {kind: 'network'}>;
			expect(err.url).toMatch(/from-(string|url|request)$/);
		});
	});
});
