import {Result} from 'ts-results-es';

import {CLI_GITHUB_API_PATH, PAP_CONNECTION_HEADER} from '@proxy/contracts/cli-github';
import {Do} from '@proxy/utils/do';

import {papServer, type PapServer} from './client';
import {type Env, EXIT, type Handler, type Io} from './io';
import {findProgram, namedConnection, SHIM_DIR_ENV} from './programs';

/**
 * `pap gh`: the real gh, run with its arguments, stdio and exit code as they are, signed in to
 * GitHub as the connection's account through PAP, its token never in the sandbox. gh is run with a
 * config directory of pap's own, made for this run and removed after it, whose `config.yml` sets
 * `http_unix_socket`: gh then sends every HTTP request, as plain HTTP with the host it is for,
 * over a unix socket there, to a server in this process that relays it by its `Host`:
 * `api.github.com` to PAP's API relay with the command's token (@proxy/contracts/cli-github);
 * `uploads.github.com`, where release assets go, answered here as not supported yet; any other,
 * such as the hosts GitHub redirects downloads to, fetched directly with no credential. gh is given
 * a placeholder for a token, as it won't run signed out, and a `git` first on its PATH that runs
 * `pap git`, so the git it runs for a clone or a push goes through PAP too; `pap git` looks past it
 * for the real one.
 */

const API_HOST = 'api.github.com';
const UPLOADS_HOST = 'uploads.github.com';

/** What gh is given for a token: never a real one, and PAP takes no notice of it. */
export const GH_TOKEN_PLACEHOLDER = 'pap-gh-placeholder';

const UPLOADS_UNSUPPORTED = 'Uploading release assets isn’t supported through pap gh yet.';

// Hop-by-hop, or about the way here; and gh's own Authorization, which is the placeholder.
const NOT_FORWARDED = new Set([
	'authorization',
	'connection',
	'content-length',
	'host',
	'keep-alive',
	'proxy-authorization',
	'proxy-connection',
	'te',
	'trailer',
	'transfer-encoding',
	'upgrade',
]);

// The body is passed back decoded, so its length and encoding are no longer what they were.
const NOT_PASSED_BACK = new Set([
	'connection',
	'content-encoding',
	'content-length',
	'keep-alive',
	'transfer-encoding',
]);

// Statuses whose answer has no body.
const NO_BODY = new Set([101, 103, 204, 205, 304]);

export type GhRoute =
	{kind: 'pap'; url: string} | {kind: 'uploads'} | {kind: 'direct'; url: string};

/** Where a request gh sent for `host` and `path` (with its query) goes. */
export function ghRoute(host: string, path: string, base: string): GhRoute {
	const name = host.toLowerCase().replace(/:\d+$/, '');
	if (name === API_HOST) {
		return {kind: 'pap', url: `${base}${CLI_GITHUB_API_PATH}${path}`};
	}
	if (name === UPLOADS_HOST) {
		return {kind: 'uploads'};
	}
	return {kind: 'direct', url: `https://${host}${path}`};
}

function githubError(status: number, message: string): Response {
	return Response.json({message, documentation_url: 'https://docs.github.com/rest'}, {status});
}

/** The server gh's requests come to, relaying each by its `Host`, until `signal` ends them. */
export function ghRelay(
	io: Io,
	server: PapServer,
	connection: string | undefined,
	signal?: AbortSignal,
): Handler {
	return async (request) => {
		const url = new URL(request.url);
		const route = ghRoute(url.host, `${url.pathname}${url.search}`, server.base);
		if (route.kind === 'uploads') {
			return githubError(422, UPLOADS_UNSUPPORTED);
		}
		const headers = new Headers();
		request.headers.forEach((value, name) => {
			if (!NOT_FORWARDED.has(name)) {
				headers.append(name, value);
			}
		});
		if (route.kind === 'pap') {
			headers.set('authorization', `Bearer ${server.token}`);
			if (connection) {
				headers.set(PAP_CONNECTION_HEADER, connection);
			}
		}
		const hasBody = request.method !== 'GET' && request.method !== 'HEAD';
		const init: RequestInit & {duplex: 'half'} = {
			method: request.method,
			headers,
			body: hasBody ? request.body : null,
			duplex: 'half',
			redirect: 'manual',
			signal,
		};
		const answered = await Result.wrapAsync<Response, Error>(() => io.fetch(route.url, init));
		if (answered.isErr()) {
			const where = route.kind === 'pap' ? `PAP at ${server.base}` : new URL(route.url).host;
			return githubError(502, `Could not reach ${where}: ${answered.error.message}. Try again.`);
		}
		const response = answered.value;
		const back = new Headers();
		response.headers.forEach((value, name) => {
			if (!NOT_PASSED_BACK.has(name)) {
				back.append(name, value);
			}
		});
		const body = NO_BODY.has(response.status) || request.method === 'HEAD' ? null : response.body;
		return new Response(body, {
			status: response.status,
			statusText: response.statusText,
			headers: back,
		});
	};
}

/** gh's `config.yml`: its requests to the socket, git over https, nothing asked or sent elsewhere. */
export function ghConfig(socket: string): string {
	return [
		`http_unix_socket: ${JSON.stringify(socket)}`,
		'git_protocol: https',
		'prompt: disabled',
		'telemetry: disabled',
		'',
	].join('\n');
}

function shellQuote(text: string): string {
	return `'${text.replaceAll("'", `'\\''`)}'`;
}

/** The `git` gh finds first: this pap's `pap git`, by absolute paths. */
export function gitShim(self: Io['self']): string {
	return `#!/bin/sh\nexec ${shellQuote(self.node)} ${shellQuote(self.script)} git "$@"\n`;
}

/** gh's environment: pap's, with its config directory, the placeholder token and the shim. */
export function ghEnv(env: Env, dir: string, shimDir: string): Env {
	return {
		...env,
		GH_CONFIG_DIR: dir,
		GH_TOKEN: GH_TOKEN_PLACEHOLDER,
		GH_PROMPT_DISABLED: '1',
		GH_NO_UPDATE_NOTIFIER: '1',
		GH_NO_EXTENSION_UPDATE_NOTIFIER: '1',
		PATH: env.PATH ? `${shimDir}:${env.PATH}` : shimDir,
		[SHIM_DIR_ENV]: shimDir,
	};
}

// gh run in `dir`, with the relay listening there until it exits.
function runGhIn(
	io: Io,
	gh: string,
	args: string[],
	dir: string,
	server: PapServer,
): Promise<Result<number, Error>> {
	return Do(async ($) => {
		const socket = `${dir}/s`;
		const shimDir = `${dir}/bin`;
		$(await io.writeFile(`${dir}/config.yml`, ghConfig(socket), 0o600));
		$(await io.writeFile(`${shimDir}/git`, gitShim(io.self), 0o755));
		// Whatever gh left unanswered is dropped once it exits, so pap exits too.
		const relayed = new AbortController();
		const handler = ghRelay(io, server, namedConnection(io), relayed.signal);
		const close = $(await io.serve(socket, handler));
		const ran = await io.spawn(gh, args, ghEnv(io.env, dir, shimDir));
		relayed.abort();
		await close();
		return $(ran);
	});
}

export const GH_NOTE = `pap gh <args>: GitHub's gh, signed in as your GitHub connection's account; plain gh is signed out.
The git it runs is pap git. Uploading release assets isn't supported yet.
With several GitHub connections: pap --connection <id> gh <args>
`;

/** `pap gh <args>`: gh run as above, its directory removed once it exits, its exit code pap's. */
export async function ghMain(args: string[], io: Io): Promise<number> {
	if (args.length === 0) {
		io.out(GH_NOTE);
		return EXIT.ok;
	}
	const gh = findProgram('gh', io, [io.env[SHIM_DIR_ENV]]);
	if (gh === null) {
		io.err('pap: gh is not installed here: install GitHub’s gh, then run pap gh again.\n');
		return EXIT.failed;
	}
	const server = papServer(io);
	if (server.isErr()) {
		io.err(`pap: ${server.error.message}\n`);
		return server.error.exit;
	}
	const dir = await io.makeTempDir();
	if (dir.isErr()) {
		io.err(`pap: could not make a directory for gh: ${dir.error.message}\n`);
		return EXIT.failed;
	}
	const ran = await runGhIn(io, gh, args, dir.value, server.value);
	await io.removeDir(dir.value);
	if (ran.isErr()) {
		io.err(`pap: could not run gh: ${ran.error.message}\n`);
		return EXIT.failed;
	}
	return ran.value;
}
