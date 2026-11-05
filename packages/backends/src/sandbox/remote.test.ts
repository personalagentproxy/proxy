import {afterAll, describe, expect, test} from 'bun:test';

import {remoteSandboxBackend} from './remote';

/**
 * The client's side of the protocol, against a stand-in service with canned answers: what each
 * method sends, and what each kind of answer comes back as. The protocol end to end, this client
 * against the service that speaks it, is tested where that service is, in the internal repo.
 */

const TOKEN = 'a-token-long-enough-for-the-tests-to-use';

type Seen = {method: string; path: string; authorization: string | null; requestId: string | null; body: string};
const seen: Seen[] = [];

function json(body: unknown, status = 200): Response {
	return Response.json(body, {status});
}

const service = Bun.serve({
	port: 0,
	async fetch(request) {
		const {pathname} = new URL(request.url);
		seen.push({method: request.method, path: pathname, authorization: request.headers.get('authorization'), requestId: request.headers.get('x-request-id'), body: await request.text()});
		if (request.headers.get('authorization') !== `Bearer ${TOKEN}`) {
			return json({error: {kind: 'unauthenticated'}}, 401);
		}
		if (pathname === '/sandboxes' && request.method === 'POST') {
			return seen.at(-1)?.body.includes('"sandboxId":"taken"') ? json({error: {kind: 'parse_error', message: 'that id is taken'}}, 400) : json({ref: 'r1'});
		}
		if (pathname === '/sandboxes/r%201/exec') {
			return json({stdout: 'hi\n', stderr: '', exitCode: 0, timedOut: false});
		}
		if (pathname === '/sandboxes/asleep/exec') {
			return json({error: {kind: 'conflict', message: 'The sandbox is asleep'}}, 409);
		}
		if (pathname === '/sandboxes/r1/sleep' || pathname === '/sandboxes/r1/wake') {
			return json({ref: 'r2'});
		}
		if (pathname === '/sandboxes/gone') {
			return json({error: {kind: 'not_found', message: 'There is no such sandbox'}}, 404);
		}
		if (pathname === '/sandboxes/r1' && request.method === 'DELETE') {
			return json({});
		}
		if (pathname === '/sandboxes/broken/wake') {
			return new Response('<html>502 Bad Gateway</html>', {status: 502});
		}
		return json({error: {kind: 'not_found'}}, 404);
	},
});

const remote = remoteSandboxBackend({url: `http://localhost:${service.port}/`, token: TOKEN});

afterAll(async () => {
	await service.stop(true);
});

describe('the remote sandbox backend', () => {
	test('sends each method as its route, with the token, the ref encoded in the path', async () => {
		expect((await remote.create({tenant: 'org-1', sandboxId: 'one'})).unwrap()).toBe('r1');
		expect((await remote.exec('r 1', {command: 'echo hi', timeoutMs: 1000})).unwrap()).toEqual({stdout: 'hi\n', stderr: '', exitCode: 0, timedOut: false});
		expect((await remote.sleep('r1')).unwrap()).toBe('r2');
		expect((await remote.wake('r1')).unwrap()).toBe('r2');
		expect((await remote.destroy('r1')).unwrap()).toBeUndefined();

		expect(seen.map(({method, path}) => `${method} ${path}`)).toEqual(['POST /sandboxes', 'POST /sandboxes/r%201/exec', 'POST /sandboxes/r1/sleep', 'POST /sandboxes/r1/wake', 'DELETE /sandboxes/r1']);
		expect(seen.every((request) => request.authorization === `Bearer ${TOKEN}`)).toBe(true);
		expect(JSON.parse(seen[0]!.body)).toEqual({tenant: 'org-1', sandboxId: 'one'});
		expect(JSON.parse(seen[1]!.body)).toEqual({command: 'echo hi', timeoutMs: 1000});
		expect(seen[2]!.body).toBe('');
	});

	test('what the service refuses comes back as the api’s kind, with its words', async () => {
		expect((await remote.create({tenant: 'org-1', sandboxId: 'taken'})).unwrapErr()).toMatchObject({kind: 'validation_error', message: 'that id is taken'});
		expect((await remote.exec('asleep', {command: 'ls', timeoutMs: 1000})).unwrapErr()).toMatchObject({kind: 'conflict', message: 'The sandbox is asleep'});
		expect((await remote.destroy('gone')).unwrapErr()).toMatchObject({kind: 'not_found', message: 'There is no such sandbox'});
	});

	test('sends the headers it is given with each request, such as the api’s request id', async () => {
		let requestId = 'first';
		const withId = remoteSandboxBackend({url: `http://localhost:${service.port}`, token: TOKEN, headers: () => ({'x-request-id': requestId})});
		await withId.sleep('r1');
		requestId = 'second';
		await withId.wake('r1');
		expect(seen.slice(-2).map((request) => request.requestId)).toEqual(['first', 'second']);
		expect(seen.at(-1)?.authorization).toBe(`Bearer ${TOKEN}`);
	});

	test('a wrong token is the service being unavailable to this server', async () => {
		const other = remoteSandboxBackend({url: `http://localhost:${service.port}`, token: 'another'});
		expect((await other.create({tenant: 'org-1', sandboxId: 'one'})).unwrapErr()).toMatchObject({kind: 'unavailable'});
	});

	test('a service that cannot be reached, or answers with something else, is a provider out of reach', async () => {
		expect((await remoteSandboxBackend({url: 'http://localhost:1', token: TOKEN}).wake('nothing')).unwrapErr()).toMatchObject({kind: 'provider_unreachable'});
		expect((await remote.wake('broken')).unwrapErr()).toMatchObject({kind: 'provider_unreachable'});
	});
});
