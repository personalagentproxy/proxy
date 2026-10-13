import {Err, type Result} from 'ts-results-es';
import type {z} from 'zod';

import {httpRequest, type FetchError} from '@proxy/utils';

import {checkUrl} from './host-check';

/**
 * A request to an address that came from outside: a custom MCP server's, its metadata's, or its
 * authorization server's, wherever that server said they are. The address is checked as a
 * database's host is (`host-check.ts`) before every request, so nothing the api is pointed at
 * reaches its own network, and no request follows a redirect, since one could lead there too.
 * An address the check refuses is the server out of reach (`network`), the refusal its cause.
 */
export function checkedRequest<S extends z.ZodType>(
	url: string,
	init: RequestInit,
	opts: {schema: S; timeoutMs?: number; allowStatus?: (status: number) => boolean},
): Promise<Result<z.infer<S>, FetchError>>;
export function checkedRequest(url: string, init: RequestInit, opts: {parse: 'response'; timeoutMs?: number; allowStatus?: (status: number) => boolean}): Promise<Result<Response, FetchError>>;
export function checkedRequest(url: string, init: RequestInit, opts: {timeoutMs?: number; allowStatus?: (status: number) => boolean}): Promise<Result<void, FetchError>>;
export async function checkedRequest(
	url: string,
	init: RequestInit,
	opts: {schema?: z.ZodType; parse?: 'response'; timeoutMs?: number; allowStatus?: (status: number) => boolean},
): Promise<Result<unknown, FetchError>> {
	if (!URL.canParse(url)) {
		return Err<FetchError>({kind: 'network', url, cause: new Error(`${url} is not an address`)});
	}
	const checked = await checkUrl(new URL(url));
	if (checked.isErr()) {
		return Err<FetchError>({kind: 'network', url, cause: new Error('message' in checked.error ? checked.error.message : checked.error.kind)});
	}
	const request = {...init, redirect: 'error' as const};
	const {schema, parse, ...base} = opts;
	if (schema) {
		return httpRequest(url, request, {...base, schema});
	}
	if (parse === 'response') {
		return httpRequest(url, request, {...base, parse});
	}
	return httpRequest(url, request, base);
}
