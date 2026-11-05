import {afterAll, describe, expect, test} from 'bun:test';
import {mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

import {sandboxBackendTests} from './conformance';
import {remoteSandboxBackend} from './remote';
import {serveSandboxBackend} from './serve';
import {tempDirSandboxBackend} from './temp-dir';

// The protocol, both ends: the temp-dir backend behind the server, the remote client in front.
const TOKEN = 'a-token-long-enough-for-the-tests-to-use';
const servers: Array<ReturnType<typeof Bun.serve>> = [];

function serve(token = TOKEN): string {
	const backend = tempDirSandboxBackend(mkdtempSync(join(tmpdir(), 'proxy-sandboxes-')));
	const server = Bun.serve({port: 0, fetch: serveSandboxBackend(backend, {token})});
	servers.push(server);
	return `http://localhost:${server.port}`;
}

afterAll(async () => {
	await Promise.all(servers.map((server) => server.stop(true)));
});

sandboxBackendTests(async () => remoteSandboxBackend({url: serve(), token: TOKEN}));

describe('over the protocol', () => {
	test('a wrong token is the service being unavailable to this server, and nothing is run', async () => {
		const remote = remoteSandboxBackend({url: serve(), token: 'another'});
		expect((await remote.create({tenant: 'org-1', sandboxId: 'one'})).unwrapErr()).toMatchObject({kind: 'unavailable'});
	});

	test('the health check takes no token', async () => {
		const response = await fetch(`${serve()}/health`);
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ok: true});
	});

	test('a service that cannot be reached is a provider out of reach', async () => {
		const remote = remoteSandboxBackend({url: 'http://localhost:1', token: TOKEN});
		expect((await remote.wake('nothing')).unwrapErr()).toMatchObject({kind: 'provider_unreachable'});
	});

	test('what the service refuses comes back as its kind, with its words', async () => {
		const url = serve();
		const response = await fetch(`${url}/sandboxes`, {method: 'POST', headers: {authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json'}, body: '{"tenant": ""}'});
		expect(response.status).toBe(400);
		expect(await response.json()).toMatchObject({error: {kind: 'parse_error'}});
		expect((await fetch(`${url}/nothing`, {headers: {authorization: `Bearer ${TOKEN}`}})).status).toBe(404);
	});
});
