import type {FetchError} from '@proxy/utils';
import {data, redirect} from 'react-router';
import type {Result} from 'ts-results-es';
import {isNotFoundError, isUnauthenticatedError} from '@/client/me-client';

export function unwrapLoaderResult<T>(result: Result<T, FetchError>): T {
	if (result.isOk()) {
		return result.value;
	}

	throw fetchErrorToResponse(result.error);
}

// Keeps where the user was headed so they land back there after signing in. Skipped at the root,
// where sign-in goes anyway, and on /login itself, which would loop.
function buildLoginRedirect(): string {
	const returnTo = window.location.pathname + window.location.search;
	if (returnTo === '/' || window.location.pathname === '/login') {
		return '/login';
	}

	return `/login?callbackUrl=${encodeURIComponent(returnTo)}`;
}

export function fetchErrorToResponse(error: FetchError): never {
	if (isUnauthenticatedError(error)) {
		throw redirect(buildLoginRedirect());
	}

	if (isNotFoundError(error)) {
		throw data(null, {status: 404});
	}

	throw data(error.kind, {status: 500});
}
