import {createHash, timingSafeEqual} from 'node:crypto';

import {Err, Result} from 'ts-results-es';
import type {z} from 'zod';

import {ApiErr, type ApiError, parseSchema} from '@proxy/utils';
import {createSandboxBodySchema, execSandboxBodySchema, type SandboxError} from '@proxy/contracts/sandbox';

import type {SandboxBackend} from './backend';

/**
 * Any sandbox backend behind the protocol (`@proxy/contracts/sandbox`), as a handler of
 * requests for `Bun.serve` or anything that takes one: what hosted Personal Agent Proxy runs its
 * own behind, and the conformance tests run the client against. Every request but the health
 * check carries the token; what a backend says went wrong goes out as the api's kind of error,
 * with its status, and without its cause, which is the service's own.
 */

export type ServeSandboxOptions = {token: string};

export type RequestHandler = (request: Request) => Promise<Response>;

function sha256(text: string): Buffer {
	return createHash('sha256').update(text).digest();
}

// Both sides hashed first, so the comparison takes the same time whatever was sent.
function hasToken(request: Request, token: string): boolean {
	const header = request.headers.get('authorization');
	if (!header?.startsWith('Bearer ')) {
		return false;
	}
	return timingSafeEqual(sha256(header.slice('Bearer '.length)), sha256(token));
}

function json(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {status, headers: {'content-type': 'application/json'}});
}

// What the client is told: the kind, and the message where the error is one that carries words
// for the caller; never a cause.
function failure(error: ApiError): Response {
	const message = 'message' in error ? error.message : undefined;
	const body: SandboxError = {error: {kind: error.kind, ...(message === undefined ? {} : {message})}};
	return json(body, error.statusCode);
}

function answer<T>(result: Result<T, ApiError>): Response {
	if (result.isErr()) {
		return failure(result.error);
	}
	return json(result.value);
}

async function readBody<T>(request: Request, schema: z.ZodType<T>): Promise<Result<T, ApiError>> {
	const text = await Result.wrapAsync(() => request.text());
	if (text.isErr()) {
		return Err(ApiErr.validationError('The body could not be read'));
	}
	const value = Result.wrap((): unknown => JSON.parse(text.value || '{}'));
	if (value.isErr()) {
		return Err(ApiErr.validationError('The body is not JSON'));
	}
	return parseSchema(schema, value.value);
}

// `/sandboxes/<ref>` and `/sandboxes/<ref>/<action>`: the ref, decoded, and the action if any.
function sandboxPath(pathname: string): {ref: string; action: string | null} | null {
	const match = /^\/sandboxes\/([^/]+)(?:\/(exec|sleep|wake))?$/.exec(pathname);
	if (!match?.[1]) {
		return null;
	}
	const decoded = Result.wrap(() => decodeURIComponent(match[1] ?? ''));
	if (decoded.isErr()) {
		return null;
	}
	return {ref: decoded.value, action: match[2] ?? null};
}

/** The handler: `backend` behind the protocol, taking only requests that carry `token`. */
export function serveSandboxBackend(backend: SandboxBackend, {token}: ServeSandboxOptions): RequestHandler {
	return async (request) => {
		const {pathname} = new URL(request.url);
		if (request.method === 'GET' && pathname === '/health') {
			return json({ok: true});
		}
		if (!hasToken(request, token)) {
			return failure(ApiErr.unauthenticated());
		}
		if (request.method === 'POST' && pathname === '/sandboxes') {
			const body = await readBody(request, createSandboxBodySchema);
			if (body.isErr()) {
				return failure(body.error);
			}
			return answer((await backend.create(body.value)).map((ref) => ({ref})));
		}
		const path = sandboxPath(pathname);
		if (!path) {
			return failure(ApiErr.notFound('route', pathname));
		}
		if (request.method === 'DELETE' && path.action === null) {
			return answer((await backend.destroy(path.ref)).map(() => ({})));
		}
		if (request.method !== 'POST' || path.action === null) {
			return failure(ApiErr.notFound('route', pathname));
		}
		if (path.action === 'exec') {
			const body = await readBody(request, execSandboxBodySchema);
			if (body.isErr()) {
				return failure(body.error);
			}
			return answer(await backend.exec(path.ref, body.value));
		}
		const moved = path.action === 'sleep' ? await backend.sleep(path.ref) : await backend.wake(path.ref);
		return answer(moved.map((ref) => ({ref})));
	};
}
