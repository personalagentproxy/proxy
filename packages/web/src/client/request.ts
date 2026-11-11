import {httpRequest, type FetchError} from '@proxy/utils';
import type {z} from 'zod';
import {trackWrite} from '@/lib/writes-in-flight';

type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

/** Where everything in an organization is on the api, by the organization's slug: `/api/orgs/acme`. */
export function orgApi(org: string): string {
	return `/api/orgs/${encodeURIComponent(org)}`;
}

/** True when the api rejected the session — the client should send the user to sign in. */
export function isUnauthenticatedError(error: FetchError): boolean {
	return error.kind === 'http' && error.status === 401;
}

/** True when the resource is not there, or not the caller's to see — render not-found. */
export function isNotFoundError(error: FetchError): boolean {
	return error.kind === 'http' && error.status === 404;
}

/** A JSON call to the api with the session cookies, parsed with `schema`. */
export function apiRequest<S extends z.ZodType>(
	method: Method,
	path: string,
	schema: S,
	body?: unknown,
) {
	const request = httpRequest(
		path,
		{
			method,
			...(body === undefined
				? {}
				: {headers: {'Content-Type': 'application/json'}, body: JSON.stringify(body)}),
		},
		{schema},
	);
	return method === 'GET' ? request : trackWrite(request);
}

/**
 * The same for calls that answer 204 No Content. `keepalive` lets the call finish after the page
 * is gone, for what is sent as it closes; the browser allows it only a small body.
 */
export function apiSend(
	method: Method,
	path: string,
	body?: unknown,
	options: {keepalive?: boolean} = {},
) {
	const request = httpRequest(path, {
		method,
		...(options.keepalive ? {keepalive: true} : {}),
		...(body === undefined
			? {}
			: {headers: {'Content-Type': 'application/json'}, body: JSON.stringify(body)}),
	});
	return method === 'GET' ? request : trackWrite(request);
}

/**
 * A file as an upload's body, parsed with `schema`: sent as bytes whatever it holds, its own type
 * beside the rest of `query` in the address, so nothing on the way reads it as anything.
 */
export function apiUpload<S extends z.ZodType>(
	method: 'POST' | 'PUT',
	path: string,
	query: Record<string, string>,
	file: File,
	schema: S,
) {
	const params = new URLSearchParams({...query, ...(file.type ? {type: file.type} : {})});
	return trackWrite(
		httpRequest(
			`${path}?${params.toString()}`,
			{method, headers: {'Content-Type': 'application/octet-stream'}, body: file},
			{schema},
		),
	);
}
