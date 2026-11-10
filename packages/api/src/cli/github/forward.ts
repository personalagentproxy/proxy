import type {IncomingHttpHeaders} from 'node:http';
import {Readable} from 'node:stream';
import {pipeline} from 'node:stream/promises';

import type {Response as ExpressResponse} from 'express';
import {Result} from 'ts-results-es';

import {PAP_CONNECTION_HEADER} from '@proxy/contracts/cli-github';

import {log, serializeError} from '../../observability/log';

/**
 * Relaying a request to GitHub and its answer back, as they stream, neither body held nor changed:
 * a gzipped one stays gzipped both ways, `Content-Encoding` and all. Going out, the request's own
 * credentials and routing are taken off, the PAP token, cookies, the connection it named, `Host`
 * and the hop-by-hop headers among them, and the connection's GitHub token put on; everything else
 * goes as the client sent it. Coming back, GitHub's status and headers are passed on but for the
 * hop-by-hop ones, its cookies, and `WWW-Authenticate`, which would have git ask for a password for
 * Personal Agent Proxy. A redirect is passed back as it is, never followed.
 */

// Hop-by-hop, or about the way to Personal Agent Proxy rather than GitHub.
const HOP_BY_HOP = ['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'proxy-connection', 'te', 'trailer', 'trailers', 'transfer-encoding', 'upgrade'];
const NOT_FORWARDED = new Set([...HOP_BY_HOP, 'host', 'authorization', 'cookie', 'expect', 'forwarded', 'via', 'x-real-ip', 'x-request-id', PAP_CONNECTION_HEADER]);
const NOT_PASSED_BACK = new Set([...HOP_BY_HOP, 'www-authenticate', 'set-cookie']);

// The headers a `Connection` header names as hop-by-hop for this one message.
function namedHopByHop(connection: string | string[] | null | undefined): string[] {
	const value = Array.isArray(connection) ? connection.join(',') : (connection ?? '');
	return value
		.split(',')
		.map((name) => name.trim().toLowerCase())
		.filter((name) => name !== '');
}

/** The request's headers to send GitHub, with `authorization` to send instead of the client's. */
export function forwardedHeaders(incoming: IncomingHttpHeaders, authorization: string): Headers {
	const dropped = new Set([...NOT_FORWARDED, ...namedHopByHop(incoming.connection)]);
	const headers = new Headers();
	for (const [name, value] of Object.entries(incoming)) {
		if (value === undefined || dropped.has(name) || name.startsWith('x-forwarded-')) {
			continue;
		}
		for (const one of Array.isArray(value) ? value : [value]) {
			headers.append(name, one);
		}
	}
	headers.set('authorization', authorization);
	return headers;
}

/** GitHub's answer's headers to pass back. */
export function passedBackHeaders(upstream: Headers): Record<string, string | string[]> {
	const dropped = new Set([...NOT_PASSED_BACK, ...namedHopByHop(upstream.get('connection'))]);
	const headers: Record<string, string | string[]> = {};
	upstream.forEach((value, name) => {
		if (dropped.has(name)) {
			return;
		}
		headers[name] = value;
	});
	return headers;
}

export type Relayed = {method: string; url: URL; headers: Headers; body: ReadableStream<Uint8Array> | Uint8Array<ArrayBuffer> | null; signal: AbortSignal};

/** GitHub's answer, as it starts to come, or the error that kept it from coming. */
export async function relay(request: Relayed): Promise<Result<Response, Error>> {
	const {method, url, headers, body, signal} = request;
	return Result.wrapAsync(() =>
		fetch(url, {
			method,
			headers,
			body,
			signal,
			// Bun's own: the answer's body as GitHub sent it, so a gzipped one is passed back with its Content-Encoding.
			decompress: false,
			redirect: 'manual',
		}),
	).then((answer) => answer.mapErr((error) => (error instanceof Error ? error : new Error(String(error)))));
}

/** Ends the relay when the client goes: GitHub's request is aborted with it. */
export function abortWithClient(response: ExpressResponse): AbortController {
	const controller = new AbortController();
	response.on('close', () => {
		if (!response.writableFinished) {
			controller.abort();
		}
	});
	return controller;
}

/** Passes GitHub's answer back as it comes; a stream cut off on either side is logged and ends the response. */
export async function passBack(response: ExpressResponse, upstream: Response): Promise<void> {
	response.writeHead(upstream.status, passedBackHeaders(upstream.headers));
	const {body} = upstream;
	if (body === null) {
		response.end();
		return;
	}
	const piped = await Result.wrapAsync(() => pipeline(Readable.from(body), response));
	if (piped.isErr()) {
		log.warn('A GitHub answer was cut off while relayed', serializeError(piped.error));
	}
}
