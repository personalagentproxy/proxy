import {Ok, type Result} from 'ts-results-es';

import type {Env, Handler, Io} from './io';

/**
 * An `Io` for the tests, run.test.ts, git.test.ts and gh.test.ts: what pap wrote, the programs it
 * ran and with what, the files it wrote, the servers it started and the directories it removed,
 * with `fetch` and the programs' exit code as the test makes them. Not part of the bundle.
 */

export type FakeOptions = {
	env?: Env;
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
			return Ok(undefined);
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
	return {io, output, spawned, files, servers, removed};
}
