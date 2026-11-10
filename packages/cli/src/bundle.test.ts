import {afterAll, beforeAll, describe, expect, test} from 'bun:test';
import {mkdtemp, rm, writeFile} from 'node:fs/promises';
import {createServer, type Server} from 'node:http';
import type {AddressInfo} from 'node:net';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

import {buildPap, type PapBundle} from './build';

// The bundle as a sandbox runs it: built, written out as `pap`, and run by plain Node, not Bun,
// against a server standing in for the api.

let directory = '';
let bundle: PapBundle;
let server: Server;
let url = '';
const received: Array<{authorization: string | undefined; body: string}> = [];

beforeAll(async () => {
	bundle = (await buildPap()).unwrap();
	directory = await mkdtemp(join(tmpdir(), 'pap-bundle-'));
	await writeFile(join(directory, 'pap'), bundle.code, {mode: 0o755});
	server = createServer((req, res) => {
		let body = '';
		req.on('data', (chunk: Buffer) => {
			body += chunk.toString();
		});
		req.on('end', () => {
			received.push({authorization: req.headers.authorization, body});
			const ok = req.headers.authorization === 'Bearer good' && req.url === '/api/cli/call';
			res.writeHead(ok ? 200 : 401, {'content-type': 'application/json'});
			res.end(
				ok
					? JSON.stringify({result: [{connection: 'vault-1', integration: 'Vault'}]})
					: JSON.stringify({error: 'unauthenticated', message: 'PAP_TOKEN is not a valid token.'}),
			);
		});
	});
	await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
	url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
	server.close();
	await rm(directory, {recursive: true, force: true});
});

async function node(args: string[], env: Record<string, string>) {
	const child = Bun.spawn(['node', join(directory, 'pap'), ...args], {
		env: {PATH: process.env.PATH ?? '', ...env},
		stdout: 'pipe',
		stderr: 'pipe',
	});
	const [stdout, stderr, code] = await Promise.all([
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
		child.exited,
	]);
	return {stdout, stderr, code};
}

describe('the pap bundle under node', () => {
	test('is one file starting with its shebang, its version the build’s', async () => {
		expect(bundle.code.startsWith('#!/usr/bin/env node\n')).toBe(true);
		expect(bundle.version).toMatch(/^[0-9a-f]{12}$/);
		expect(await node(['--version'], {})).toEqual({
			stdout: `${bundle.version}\n`,
			stderr: '',
			code: 0,
		});
	});

	test('calls the server with the token and prints its result', async () => {
		const result = await node(['connections'], {PAP_URL: url, PAP_TOKEN: 'good'});

		expect(result).toEqual({
			stdout: '[{"connection":"vault-1","integration":"Vault"}]\n',
			stderr: '',
			code: 0,
		});
		expect(received.at(-1)).toEqual({
			authorization: 'Bearer good',
			body: '{"method":"connections","args":[]}',
		});
	});

	test('a refused token exits 3 with the server’s words on stderr', async () => {
		expect(await node(['connections'], {PAP_URL: url, PAP_TOKEN: 'bad'})).toEqual({
			stdout: '',
			stderr: 'pap: PAP_TOKEN is not a valid token.\n',
			code: 3,
		});
	});

	test('reads params from stdin', async () => {
		const child = Bun.spawn(
			['node', join(directory, 'pap'), 'call', 'vault-1', 'entries_list', '-'],
			{
				env: {PATH: process.env.PATH ?? '', PAP_URL: url, PAP_TOKEN: 'good'},
				stdin: new TextEncoder().encode('{"search":"x"}'),
				stdout: 'pipe',
			},
		);
		expect(await child.exited).toBe(0);
		expect(received.at(-1)?.body).toBe(
			'{"method":"call","args":["vault-1","entries_list",{"search":"x"}]}',
		);
	});
});
