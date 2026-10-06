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

// A detail page's record: null when its id points at nothing, so the page says so in its own frame.
export function unwrapOrNull<T>(result: Result<T, FetchError>): T | null {
	if (result.isErr() && isNotFoundError(result.error)) {
		return null;
	}
	return unwrapLoaderResult(result);
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

/** What a failed change tells the person who made it. */
export function describeFetchError(error: FetchError): string {
	if (error.kind === 'http' && error.status === 409) {
		return 'The provider does not allow that.';
	}
	if (error.kind === 'http' && error.status === 401) {
		return 'You have been signed out. Reload the page to sign in again.';
	}
	return 'Something went wrong. Try again.';
}
