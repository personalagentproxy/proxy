import type {FetchError} from '@proxy/utils';
import {data, redirect} from 'react-router';
import type {Result} from 'ts-results-es';
import {isNotFoundError, isUnauthenticatedError} from '@/client/request';
import {apiMessage} from '@/lib/agent-errors';

/**
 * A loader's answer, or the response its failure stands for: a 401 sends to `signIn` (by default
 * the person's sign-in, back to where they were), a 404 renders not-found, anything else an error.
 */
export function unwrapLoaderResult<T>(result: Result<T, FetchError>, signIn?: string): T {
	if (result.isOk()) {
		return result.value;
	}

	throw fetchErrorToResponse(result.error, signIn);
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

function fetchErrorToResponse(error: FetchError, signIn: string | undefined): never {
	if (isUnauthenticatedError(error)) {
		throw redirect(signIn ?? buildLoginRedirect());
	}

	if (isNotFoundError(error)) {
		throw data(null, {status: 404});
	}

	throw data(error.kind, {status: 500});
}

/** What a failed change tells the person who made it. */
export function describeFetchError(error: FetchError): string {
	if (error.kind === 'http' && error.status === 401) {
		return 'You have been signed out. Reload the page to sign in again.';
	}
	return 'Something went wrong. Try again.';
}

/** The same, in the api's own words where it has them, as a name already taken. */
export function describeApiError(error: FetchError): string {
	const said = error.kind === 'http' ? apiMessage(error.body) : null;
	return said ?? describeFetchError(error);
}
