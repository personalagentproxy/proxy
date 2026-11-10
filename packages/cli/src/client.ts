import {Err, Ok, Result} from 'ts-results-es';

import {CLI_CALL_PATH, CLI_STATUS, type PapMethod} from '@proxy/contracts/cli-constants';
import type {CliCallBody} from '@proxy/contracts/cli';
import {Do} from '@proxy/utils/do';

import {EXIT, type Failure, failed, type Io, isObject, type Json} from './io';

/**
 * The api as the sandbox reaches it: `PAP_URL`, with `PAP_TOKEN` as the bearer of every request
 * (@proxy/contracts/cli). `post` sends JSON to any of its paths and hands back the answer; `call`
 * is a `pap` function on `/api/cli/call`, its answer's three statuses made into the result, a
 * failed call (exit 1) and a refused token (exit 3), the server's words kept as they are.
 */

export type Client = {
	post: (
		path: string,
		body: Json,
	) => Promise<Result<{status: number; body: Json | undefined}, Failure>>;
	call: (method: PapMethod, args: Json[]) => Promise<Result<Json, Failure>>;
};

const NO_ENV =
	'PAP_URL and PAP_TOKEN are not set: run pap in a sandbox_exec command with pap: true.';

function refused(message: string): Failure {
	return {exit: EXIT.refused, message};
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
	const {PAP_URL: url, PAP_TOKEN: token} = io.env;
	if (!url || !token) {
		return Err(refused(NO_ENV));
	}
	const base = url.replace(/\/+$/, '');

	const post: Client['post'] = (path, body) =>
		Do(async ($) => {
			const init = {
				method: 'POST',
				headers: {authorization: `Bearer ${token}`, 'content-type': 'application/json'},
				body: JSON.stringify(body),
			};
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

	const call: Client['call'] = (method, args) =>
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

	return Ok({post, call});
}
