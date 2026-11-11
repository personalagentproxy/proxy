import {Err, Ok, Result} from 'ts-results-es';

import {CLI_CALL_PATH, CLI_STATUS, type PapMethod} from '@proxy/contracts/cli-constants';
import type {CliCallBody} from '@proxy/contracts/cli';
import {Do} from '@proxy/utils/do';

import {type Failure, failed, type Io, isObject, type Json, refused} from './io';

/**
 * The api as the sandbox reaches it: `PAP_URL`, with `PAP_TOKEN` as the bearer of every request
 * (@proxy/contracts/cli). `get` and `post` reach any of its paths and hand back the answer, JSON
 * where it is; `call` is a `pap` function on `/api/cli/call`, its answer's three statuses made
 * into the result, a failed call (exit 1) and a refused token (exit 3), the server's words kept as
 * they are.
 */

type Answer = {status: number; body: Json | undefined};

export type Client = {
	get: (path: string, headers: Record<string, string>) => Promise<Result<Answer, Failure>>;
	/** A request with the token, answered as it comes, its body unread: for bytes rather than JSON. */
	send: (path: string, init: RequestInit) => Promise<Result<Response, Failure>>;
	post: (path: string, body: Json) => Promise<Result<Answer, Failure>>;
	call: (method: PapMethod, args: Json[]) => Promise<Result<Json, Failure>>;
};

/** The server the environment names: its URL without a trailing slash, and the token. */
export type PapServer = {base: string; token: string};

const NO_ENV =
	'PAP_URL and PAP_TOKEN are not set: run pap in a sandbox_exec command with pap: true.';

/** The server the environment names, or refused where it names none. */
export function papServer(io: Io): Result<PapServer, Failure> {
	const {PAP_URL: url, PAP_TOKEN: token} = io.env;
	if (!url || !token) {
		return Err(refused(NO_ENV));
	}
	return Ok({base: url.replace(/\/+$/, ''), token});
}

// The server's `message`, where its answer has one.
function messageOf(body: Json | undefined): string | null {
	return isObject(body) && typeof body.message === 'string' ? body.message : null;
}

function errorText(cause: Error | string | null): string {
	return cause instanceof Error ? cause.message : String(cause);
}

/** A client for the server the environment names, or refused where it names none. */
export function clientFrom(io: Io): Result<Client, Failure> {
	return papServer(io).map(({base, token}) => {
		const authorization = `Bearer ${token}`;
		const get: Client['get'] = (path, headers) =>
			answer(io, base, path, {headers: {...headers, authorization}});
		const send: Client['send'] = async (path, init) =>
			(
				await Result.wrapAsync<Response, Error>(() =>
					io.fetch(`${base}${path}`, {...init, headers: {...init.headers, authorization}}),
				)
			).mapErr((cause) =>
				failed(`Could not reach PAP at ${base}: ${errorText(cause)}. Try again.`),
			);
		const post: Client['post'] = (path, body) =>
			answer(io, base, path, {
				method: 'POST',
				headers: {authorization, 'content-type': 'application/json'},
				body: JSON.stringify(body),
			});
		return {get, send, post, call: caller(post)};
	});
}

// The answer to a request, its body parsed where it is JSON.
function answer(
	io: Io,
	base: string,
	path: string,
	init: RequestInit,
): Promise<Result<Answer, Failure>> {
	return Do(async ($) => {
		const unreachable = (cause: Error | string | null) =>
			failed(`Could not reach PAP at ${base}: ${errorText(cause)}. Try again.`);
		const response = $(
			(await Result.wrapAsync<Response, Error>(() => io.fetch(`${base}${path}`, init))).mapErr(
				unreachable,
			),
		);
		const text = $(
			(await Result.wrapAsync<string, Error>(() => response.text())).mapErr(unreachable),
		);
		const parsed = Result.wrap((): Json => JSON.parse(text)).unwrapOr(undefined);
		return {status: response.status, body: parsed};
	});
}

// A `pap` function on `/api/cli/call`, its answer made into the result.
function caller(post: Client['post']): Client['call'] {
	return (method, args) =>
		Do(async ($) => {
			const request: CliCallBody = {method, args};
			const {status, body} = $(await post(CLI_CALL_PATH, request));
			if (status === CLI_STATUS.ok && isObject(body) && 'result' in body) {
				return body.result ?? null;
			}
			if (status === CLI_STATUS.failed) {
				return $(Err(failed(messageOf(body) ?? 'The call failed.')));
			}
			if (status === CLI_STATUS.refused) {
				return $(
					Err(
						refused(
							messageOf(body) ?? 'PAP_TOKEN was refused. Run the command again with pap: true.',
						),
					),
				);
			}
			return $(
				Err(
					failed(
						`PAP answered ${status}${status === CLI_STATUS.ok ? ' without a result' : ''}. Try again.`,
					),
				),
			);
		});
}
