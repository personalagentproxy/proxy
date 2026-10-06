import {Err, Ok, Result} from 'ts-results-es';
import type {z} from 'zod';

import {Do} from './do';

// Canonical failure surface for outbound HTTP. Callers convert to their own
// error type via mappers that live next to that type.
export type FetchError =
	| {kind: 'network'; url: string; cause: unknown}
	| {kind: 'timeout'; url: string; timeoutMs: number}
	| {kind: 'http'; url: string; status: number; body: unknown}
	| {kind: 'parse'; url: string; cause: unknown}
	| {kind: 'schema'; url: string; issues: z.core.$ZodIssue[]};

type ParseMode = 'text' | 'arrayBuffer' | 'response';

type BaseOptions = {
	/** Abort the request after `timeoutMs` and surface a `timeout` error. */
	timeoutMs?: number;
	/**
	 * Override the default "2xx is Ok" status predicate. Useful for endpoints
	 * where 304/404/etc. are expected successes (e.g. ETag-conditional GETs,
	 * "missing is fine" lookups).
	 */
	allowStatus?: (status: number) => boolean;
};

function defaultAllowStatus(status: number): boolean {
	return status >= 200 && status < 300;
}

function inputUrl(input: string | URL | Request): string {
	if (typeof input === 'string') {
		return input;
	}
	if (input instanceof URL) {
		return input.toString();
	}
	return input.url;
}

// Best-effort body decode for error reporting: try JSON, fall back to the raw
// text, fall back to null, so non-2xx responses still carry a useful body
// into the caller's error.
async function readErrorBody(response: Response): Promise<unknown> {
	const text = await Result.wrapAsync<string, unknown>(async () => response.text());
	if (text.isErr() || text.value.length === 0) {
		return null;
	}
	const parsed = Result.wrap<unknown, unknown>(() => JSON.parse(text.value) as unknown);
	return parsed.isOk() ? parsed.value : text.value;
}

async function decodeBody<T>(fn: () => Promise<T>, url: string): Promise<Result<T, FetchError>> {
	return (await Result.wrapAsync<T, unknown>(fn)).mapErr((cause) => ({kind: 'parse', url, cause}));
}

export async function readJsonValidated<S extends z.ZodType>(
	response: Response,
	schema: S,
	url: string,
): Promise<Result<z.infer<S>, FetchError>> {
	const toParseErr = (cause: unknown): FetchError => ({kind: 'parse', url, cause});
	return Do<z.infer<S>, FetchError>(async ($) => {
		const text = $((await Result.wrapAsync(async () => response.text())).mapErr(toParseErr));
		const value = $(Result.wrap(() => JSON.parse(text) as unknown).mapErr(toParseErr));
		const parsed = schema.safeParse(value);
		if (parsed.success) {
			return parsed.data;
		}
		return $(Err<FetchError>({kind: 'schema', url, issues: parsed.error.issues}));
	});
}

// Build a signal that aborts when either caller's signal aborts or the timeout
// fires. Returned `timeoutSignal` lets the error path distinguish timeout from
// caller-aborted by checking `timeoutSignal.aborted`.
function buildSignal(
	callerSignal: AbortSignal | null | undefined,
	timeoutMs: number | undefined,
): {signal: AbortSignal | undefined; timeoutSignal: AbortSignal | undefined} {
	if (timeoutMs === undefined) {
		return {signal: callerSignal ?? undefined, timeoutSignal: undefined};
	}
	const timeoutSignal = AbortSignal.timeout(timeoutMs);
	if (!callerSignal) {
		return {signal: timeoutSignal, timeoutSignal};
	}
	return {signal: AbortSignal.any([callerSignal, timeoutSignal]), timeoutSignal};
}

export function formatFetchError(error: FetchError): string {
	if (error.kind === 'http') {
		const bodyStr = typeof error.body === 'string' ? error.body : JSON.stringify(error.body);
		return `HTTP ${error.status} from ${error.url}: ${bodyStr}`;
	}
	if (error.kind === 'network') {
		return `network error for ${error.url}: ${formatCause(error.cause)}`;
	}
	if (error.kind === 'timeout') {
		return `timeout after ${error.timeoutMs}ms for ${error.url}`;
	}
	if (error.kind === 'schema') {
		return `schema mismatch for ${error.url}: ${JSON.stringify(error.issues)}`;
	}
	return `parse error for ${error.url}: ${formatCause(error.cause)}`;
}

function formatCause(cause: unknown): string {
	if (cause instanceof Error) {
		return cause.message;
	}
	return String(cause);
}

// Overloads — pick exactly one of `schema` / `parse`, or neither for a
// status-only check that discards the body.
export function httpRequest<S extends z.ZodType>(
	input: string | URL | Request,
	init: RequestInit | undefined,
	opts: BaseOptions & {schema: S; parse?: never},
): Promise<Result<z.infer<S>, FetchError>>;
export function httpRequest(
	input: string | URL | Request,
	init: RequestInit | undefined,
	opts: BaseOptions & {parse: 'text'; schema?: never},
): Promise<Result<string, FetchError>>;
export function httpRequest(
	input: string | URL | Request,
	init: RequestInit | undefined,
	opts: BaseOptions & {parse: 'arrayBuffer'; schema?: never},
): Promise<Result<ArrayBuffer, FetchError>>;
export function httpRequest(
	input: string | URL | Request,
	init: RequestInit | undefined,
	opts: BaseOptions & {parse: 'response'; schema?: never},
): Promise<Result<Response, FetchError>>;
export function httpRequest(
	input: string | URL | Request,
	init?: RequestInit,
	opts?: BaseOptions,
): Promise<Result<void, FetchError>>;
export async function httpRequest(
	input: string | URL | Request,
	init?: RequestInit,
	opts?: BaseOptions & {schema?: z.ZodType; parse?: ParseMode},
): Promise<Result<unknown, FetchError>> {
	const url = inputUrl(input);
	const allowStatus = opts?.allowStatus ?? defaultAllowStatus;

	const {signal, timeoutSignal} = buildSignal(init?.signal, opts?.timeoutMs);
	const finalInit: RequestInit | undefined =
		signal === init?.signal ? init : {...(init ?? {}), signal};

	const response = await Result.wrapAsync<Response, unknown>(async () => fetch(input, finalInit));
	if (response.isErr()) {
		if (timeoutSignal?.aborted) {
			return Err({kind: 'timeout', url, timeoutMs: opts!.timeoutMs!});
		}
		return Err({kind: 'network', url, cause: response.error});
	}

	if (!allowStatus(response.value.status)) {
		const body = await readErrorBody(response.value);
		return Err({kind: 'http', url, status: response.value.status, body});
	}

	if (opts?.schema) {
		return readJsonValidated(response.value, opts.schema, url);
	}

	if (opts?.parse === 'response') {
		return Ok(response.value);
	}

	if (opts?.parse === 'text') {
		return decodeBody(async () => response.value.text(), url);
	}

	if (opts?.parse === 'arrayBuffer') {
		return decodeBody(async () => response.value.arrayBuffer(), url);
	}

	// No schema, no parse mode — caller only cares about status. Cancel the body
	// stream so the socket can be released without buffering the response.
	await Result.wrapAsync<void, unknown>(async () => response.value.body?.cancel());
	return Ok(undefined);
}
