import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {accessSync, constants as fsConstants, statSync} from 'node:fs';
import {chmod, mkdir, mkdtemp, rm, writeFile} from 'node:fs/promises';
import {createServer, type IncomingMessage, type ServerResponse} from 'node:http';
import {constants as osConstants, tmpdir} from 'node:os';
import {dirname, join, resolve} from 'node:path';

import {Err, Ok, Result} from 'ts-results-es';

import type {Env, Handler, Io} from './io';

/**
 * Node's process as pap's `Io` (io.ts), for main.ts. A program pap runs shares its stdin, stdout
 * and stderr, and is passed the signals pap is sent while it runs, so pap outlives it and cleans up
 * after it. The unix socket server turns each request into a fetch `Request` for its handler, and
 * streams the `Response` back.
 */

const SIGNALS: NodeJS.Signals[] = ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGQUIT'];

// A unix socket's path is cut off past about 100 bytes; a temp directory longer than this is not used.
const MAX_TEMP_BASE = 60;

// Not passed to the handler: about the way here, not the request.
const HOP_BY_HOP = new Set(['connection', 'host', 'keep-alive', 'transfer-encoding', 'upgrade']);

async function readStdin(): Promise<string> {
	const chunks: Buffer[] = [];
	for await (const chunk of process.stdin) {
		chunks.push(Buffer.from(chunk));
	}
	return Buffer.concat(chunks).toString('utf8');
}

function isExecutable(path: string): boolean {
	return Result.wrap(() => {
		accessSync(path, fsConstants.X_OK);
		return statSync(path).isFile();
	}).unwrapOr(false);
}

function spawnProgram(file: string, args: string[], env: Env): Promise<Result<number, Error>> {
	return new Promise((done) => {
		const child = spawn(file, args, {stdio: 'inherit', env});
		const forward = (signal: NodeJS.Signals) => {
			child.kill(signal);
		};
		const finish = (result: Result<number, Error>) => {
			for (const signal of SIGNALS) {
				process.off(signal, forward);
			}
			done(result);
		};
		for (const signal of SIGNALS) {
			process.on(signal, forward);
		}
		child.once('error', (error) => finish(Err(error)));
		child.once('exit', (code, signal) => {
			finish(Ok(code ?? 128 + (signal === null ? 0 : osConstants.signals[signal])));
		});
	});
}

function makeTempDir(): Promise<Result<string, Error>> {
	const base = tmpdir().length <= MAX_TEMP_BASE ? tmpdir() : '/tmp';
	return Result.wrapAsync<string, Error>(() => mkdtemp(join(base, 'pap-')));
}

function writeFileWithMode(path: string, text: string, mode: number): Promise<Result<void, Error>> {
	return Result.wrapAsync<void, Error>(async () => {
		await mkdir(dirname(path), {recursive: true, mode: 0o700});
		await writeFile(path, text, {mode});
		await chmod(path, mode);
	});
}

async function removeDir(path: string): Promise<void> {
	await Result.wrapAsync(() => rm(path, {recursive: true, force: true}));
}

// The request's body as a stream, read as it is asked for.
function bodyOf(req: IncomingMessage): ReadableStream<Uint8Array> {
	return new ReadableStream<Uint8Array>({
		start(controller) {
			req.on('data', (chunk: Buffer) => {
				controller.enqueue(new Uint8Array(chunk));
				if ((controller.desiredSize ?? 0) <= 0) {
					req.pause();
				}
			});
			req.once('end', () => controller.close());
			req.once('error', (error) => controller.error(error));
		},
		pull() {
			req.resume();
		},
		cancel() {
			req.destroy();
		},
	});
}

function requestOf(req: IncomingMessage): Request {
	const headers = new Headers();
	for (const [name, value] of Object.entries(req.headers)) {
		if (value === undefined || HOP_BY_HOP.has(name)) {
			continue;
		}
		for (const one of Array.isArray(value) ? value : [value]) {
			headers.append(name, one);
		}
	}
	const method = req.method ?? 'GET';
	const hasBody = method !== 'GET' && method !== 'HEAD';
	const init: RequestInit & {duplex: 'half'} = {
		method,
		headers,
		body: hasBody ? bodyOf(req) : null,
		duplex: 'half',
	};
	return new Request(`http://${req.headers.host ?? 'localhost'}${req.url ?? '/'}`, init);
}

async function writeBody(res: ServerResponse, body: ReadableStream<Uint8Array>): Promise<void> {
	const reader = body.getReader();
	for (;;) {
		const {done, value} = await reader.read();
		if (done) {
			res.end();
			return;
		}
		if (!res.write(value)) {
			await once(res, 'drain');
		}
	}
}

async function answer(handler: Handler, req: IncomingMessage, res: ServerResponse): Promise<void> {
	const request = Result.wrap(() => requestOf(req));
	if (request.isErr()) {
		res.writeHead(400, {'content-type': 'application/json'}).end('{"message":"Bad request."}');
		return;
	}
	const response = await Result.wrapAsync(() => handler(request.value));
	if (response.isErr()) {
		res.writeHead(500, {'content-type': 'application/json'}).end('{"message":"pap failed."}');
		return;
	}
	const headers: Record<string, string> = {};
	response.value.headers.forEach((value, name) => {
		headers[name] = value;
	});
	res.writeHead(response.value.status, response.value.statusText, headers);
	const {body} = response.value;
	if (body === null) {
		res.end();
		return;
	}
	const written = await Result.wrapAsync(() => writeBody(res, body));
	if (written.isErr()) {
		res.destroy();
	}
}

async function serve(path: string, handler: Handler): Promise<Result<() => Promise<void>, Error>> {
	const server = createServer((req, res) => {
		void answer(handler, req, res);
	});
	const listening = await Result.wrapAsync<void, Error>(
		() =>
			new Promise<void>((done, fail) => {
				server.once('error', fail);
				server.listen(path, () => done());
			}),
	);
	return listening.map(() => () => {
		const closed = new Promise<void>((done) => {
			server.close(() => done());
		});
		server.closeAllConnections();
		return closed;
	});
}

export function nodeIo(): Io {
	return {
		env: process.env,
		readStdin,
		out: (text) => void process.stdout.write(text),
		err: (text) => void process.stderr.write(text),
		fetch,
		self: {node: process.execPath, script: resolve(process.argv[1] ?? '')},
		isExecutable,
		spawn: spawnProgram,
		makeTempDir,
		writeFile: writeFileWithMode,
		removeDir,
		serve,
	};
}
