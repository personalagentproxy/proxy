import type {Result} from 'ts-results-es';
import type {z} from 'zod';

import {ApiErr, type ApiError, type FetchError, httpRequest} from '@proxy/utils';
import {
	createSandboxBodySchema,
	execSandboxBodySchema,
	sandboxDestroyedSchema,
	sandboxErrorSchema,
	sandboxOutputSchema,
	sandboxRefSchema,
	type CreateSandboxBody,
	type ExecSandboxBody,
} from '@proxy/contracts/sandbox';

import type {SandboxBackend} from './backend';

/**
 * A sandbox backend run as a service elsewhere, reached over the protocol
 * (`@proxy/contracts/sandbox`): hosted Personal Agent Proxy's own, or anyone's that speaks it.
 * What the service says went wrong comes back as the api's own kind of error; a service that
 * can't be reached, or answers with something else, is a provider out of reach, as any
 * provider is.
 */

// How long a request may take beyond what the command itself may.
const REQUEST_MS = 30_000;

export type RemoteSandboxOptions = {url: string; token: string};

const SERVICE_UNREACHABLE = 'The sandbox service could not be reached. Try again in a moment.';

// The service's error as the api's: its kind where the api has it, with what the service said.
function toApiError(error: FetchError): ApiError {
	if (error.kind !== 'http') {
		return ApiErr.providerUnreachable(error, SERVICE_UNREACHABLE);
	}
	const parsed = sandboxErrorSchema.safeParse(error.body);
	if (!parsed.success) {
		return ApiErr.providerUnreachable(error, SERVICE_UNREACHABLE);
	}
	const {kind, message} = parsed.data.error;
	if (kind === 'not_found') {
		return ApiErr.notFound('sandbox', undefined, message);
	}
	if (kind === 'conflict') {
		return ApiErr.conflict(message ?? 'The sandbox is busy');
	}
	if (kind === 'validation_error' || kind === 'parse_error') {
		return ApiErr.validationError(message ?? 'The sandbox service refused the request');
	}
	if (kind === 'forbidden' || kind === 'unauthenticated') {
		return ApiErr.unavailable('The sandbox service refused this server’s token');
	}
	if (kind === 'internal_error' || kind === 'db_error') {
		return ApiErr.providerUnreachable(error, 'The sandbox service failed on this. Try again in a moment; if it keeps failing, the people who run it have to look.');
	}
	return ApiErr.providerUnreachable(error, message ?? SERVICE_UNREACHABLE);
}

/** A backend at `url`, every request carrying `token`. */
export function remoteSandboxBackend({url, token}: RemoteSandboxOptions): SandboxBackend {
	const base = url.replace(/\/+$/, '');

	const call = async <S extends z.ZodType>(
		method: 'POST' | 'DELETE',
		path: string,
		body: CreateSandboxBody | ExecSandboxBody | null,
		schema: S,
		timeoutMs = REQUEST_MS,
	): Promise<Result<z.infer<S>, ApiError>> => {
		const answer = await httpRequest(
			`${base}${path}`,
			{
				method,
				headers: {authorization: `Bearer ${token}`, ...(body === null ? {} : {'content-type': 'application/json'})},
				...(body === null ? {} : {body: JSON.stringify(body)}),
			},
			{schema, timeoutMs},
		);
		return answer.mapErr(toApiError);
	};
	const at = (ref: string, action = ''): string => `/sandboxes/${encodeURIComponent(ref)}${action}`;

	return {
		id: 'remote',
		create: async (sandbox) => (await call('POST', '/sandboxes', createSandboxBodySchema.parse(sandbox), sandboxRefSchema)).map(({ref}) => ref),
		exec: (ref, command) => call('POST', at(ref, '/exec'), execSandboxBodySchema.parse(command), sandboxOutputSchema, command.timeoutMs + REQUEST_MS),
		sleep: async (ref) => (await call('POST', at(ref, '/sleep'), null, sandboxRefSchema)).map((answer) => answer.ref),
		wake: async (ref) => (await call('POST', at(ref, '/wake'), null, sandboxRefSchema)).map((answer) => answer.ref),
		destroy: async (ref) => (await call('DELETE', at(ref), null, sandboxDestroyedSchema)).map(() => undefined),
	};
}
