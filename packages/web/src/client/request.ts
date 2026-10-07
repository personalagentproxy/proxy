import {httpRequest} from '@proxy/utils';
import type {z} from 'zod';

type Method = 'GET' | 'POST' | 'PUT' | 'DELETE';

/** A JSON call to the api with the session cookies, parsed with `schema`. */
export function apiRequest<S extends z.ZodType>(
	method: Method,
	path: string,
	schema: S,
	body?: unknown,
) {
	return httpRequest(
		path,
		{
			method,
			...(body === undefined
				? {}
				: {headers: {'Content-Type': 'application/json'}, body: JSON.stringify(body)}),
		},
		{schema},
	);
}

/** The same for calls that answer 204 No Content. */
export function apiSend(method: Method, path: string, body?: unknown) {
	return httpRequest(path, {
		method,
		...(body === undefined
			? {}
			: {headers: {'Content-Type': 'application/json'}, body: JSON.stringify(body)}),
	});
}
