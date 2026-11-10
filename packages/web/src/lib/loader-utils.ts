import type {FetchError} from '@proxy/utils';
import {redirect} from 'react-router';
import type {Result} from 'ts-results-es';
import {isNotFoundError, isUnauthenticatedError} from '@/client/request';
import {apiMessage} from '@/lib/agent-errors';
import {log} from '@/lib/log';

/**
 * What a loader's request failed with, for its page to say (route-error.tsx): that the page does
 * not exist, or that it could not be loaded.
 */
export class LoadFailure extends Error {
	readonly notFound: boolean;

	constructor(notFound: boolean, kind: FetchError['kind']) {
		super(notFound ? 'Not found' : `Loading failed: ${kind}`);
		this.name = 'LoadFailure';
		this.notFound = notFound;
	}
}

/**
 * A loader's answer, or what its failure stands for: a 401 sends to `signIn` (by default the
 * person's sign-in, back to where they were), a 404 renders not-found, anything else an error.
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
		throw new LoadFailure(true, error.kind);
	}

	// The path alone, never its query, which may hold what the person searched for.
	log.warn('loader request failed', {
		kind: error.kind,
		path: new URL(error.url, window.location.origin).pathname,
		...(error.kind === 'http' ? {status: error.status} : {}),
	});
	throw new LoadFailure(false, error.kind);
}

/** Where a page is sent instead of what its loader was to load, as to sign-in once signed out. */
export class Redirected {
	readonly to: string;

	constructor(to: string) {
		this.to = to;
	}
}

/**
 * A loader's answer still on its way, so its page opens at once: the frame first, then the content
 * as the answer comes (`useLoaded`), or the page it redirects to instead.
 */
export type Later<T> = {later: Promise<T | Redirected>};

// Every answer on its way.
const onTheWay = new Set<Promise<unknown>>();

/**
 * A loader that doesn't keep the old page up until its answer has come: it answers at once with
 * the answer on its way. A redirect it throws is an answer, which the frame follows
 * (app-shell.tsx); any other failure is the content's to say, in the frame.
 */
export function later<Args, T>(load: (args: Args) => Promise<T>): (args: Args) => Later<T> {
	return (args) => {
		const loading = load(args).catch((thrown: unknown) => {
			const to = thrown instanceof Response ? thrown.headers.get('Location') : null;
			if (to === null) {
				throw thrown;
			}
			return new Redirected(to);
		});
		onTheWay.add(loading);
		// A failure is read where the content renders. One nobody reads, as of a page left before
		// its answer came, is not an unhandled rejection.
		const arrived = () => {
			onTheWay.delete(loading);
		};
		loading.then(arrived, arrived);
		return {later: loading};
	};
}

/** Resolves once every answer on its way has come, a page loaded again showing the new one. */
export async function loadsSettled(): Promise<void> {
	await Promise.allSettled([...onTheWay]);
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
