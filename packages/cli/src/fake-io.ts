import {posix} from 'node:path';

import {Err, Ok, type Result} from 'ts-results-es';

import type {Env, Handler, Io} from './io';

/**
 * An `Io` for the tests, run.test.ts, git.test.ts, gh.test.ts and files.test.ts: what pap wrote,
 * the programs it ran and with what, the files it wrote, a disk of files for `pap files`, the servers it started and the directories it removed,
 * with `fetch` and the programs' exit code as the test makes them. Not part of the bundle.
 */

export type FakeOptions = {
	env?: Env;
	/** The files there are, by their absolute paths, and the directories. */
	disk?: Record<string, Uint8Array<ArrayBuffer> | string>;
	directories?: string[];
	stdin?: string;
	fetch?: Io['fetch'];
	/** The paths that can be run. */
	executables?: string[];
	spawn?: (file: string, args: string[], env: Env) => Promise<Result<number, Error>>;
};

export function fakeIo(options: FakeOptions = {}) {
	const output = {out: '', err: ''};
	const spawned: Array<{file: string; args: string[]; env: Env}> = [];
	const files = new Map<string, {text: string; mode: number}>();
	// What `pap files` reads and writes: bytes by absolute path, text as its bytes.
	const disk = new Map<string, Uint8Array<ArrayBuffer>>(
		Object.entries(options.disk ?? {}).map(([path, content]) => [
			path,
			typeof content === 'string' ? new TextEncoder().encode(content) : content,
		]),
	);
	const servers: Array<{path: string; handler: Handler; closed: boolean}> = [];
	const removed: string[] = [];
	const io: Io = {
		env: options.env ?? {PAP_URL: 'https://app.example.com/', PAP_TOKEN: 'pap_token'},
		readStdin: async () => options.stdin ?? '',
		out: (text) => {
			output.out += text;
		},
		err: (text) => {
			output.err += text;
		},
		fetch: options.fetch ?? (async () => Response.json({result: null})),
		self: {node: '/usr/bin/node', script: '/home/user/.local/bin/pap'},
		isExecutable: (path) => (options.executables ?? []).includes(path),
		spawn: async (file, args, env) => {
			spawned.push({file, args, env});
			return options.spawn ? options.spawn(file, args, env) : Ok(0);
		},
		makeTempDir: async () => Ok('/tmp/pap-1'),
		writeFile: async (path, text, mode) => {
			files.set(path, {text, mode});
			disk.set(path, new TextEncoder().encode(text));
			return Ok(undefined);
		},
		// pap is run in /work.
		absolutePath: (path) => posix.resolve('/work', path),
		isDirectory: (path) => (options.directories ?? []).includes(path.replace(/\/+$/, '')),
		readBytes: async (path) => {
			const bytes = disk.get(path);
			return bytes === undefined
				? Err(new Error(`ENOENT: no such file, open '${path}'`))
				: Ok(bytes);
		},
		readText: async (path) => {
			const bytes = disk.get(path);
			return Ok(bytes === undefined ? null : new TextDecoder().decode(bytes));
		},
		saveStream: async (path, body) => {
			const bytes = new Uint8Array(await new Response(body).arrayBuffer());
			disk.set(path, bytes);
			return Ok(bytes.byteLength);
		},
		removeDir: async (path) => {
			removed.push(path);
		},
		serve: async (path, handler) => {
			const server = {path, handler, closed: false};
			servers.push(server);
			return Ok(async () => {
				server.closed = true;
			});
		},
	};
	return {io, output, spawned, files, disk, servers, removed};
}
