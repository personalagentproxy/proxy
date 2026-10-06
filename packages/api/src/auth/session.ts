import {randomBytes, timingSafeEqual} from 'node:crypto';

import type {CookieOptions, Request, Response} from 'express';
import type {Result} from 'ts-results-es';

import {createSession} from '@proxy/db/auth';
import {sessionCookieNames, type ApiError} from '@proxy/utils';

import {log, serializeError} from '../observability/log';
import {env} from '../utils/env';

/** Helpers shared by the sign-in flows: Google OAuth in ./google.ts, magic link in ./email.ts. */

export const sessionMaxAgeSeconds = 30 * 24 * 60 * 60;

export function useSecureCookies(): boolean {
	return env.NODE_ENV === 'production';
}

export function sessionCookieName(): string {
	if (useSecureCookies()) {
		return sessionCookieNames.secure;
	}

	return sessionCookieNames.insecure;
}

// Dev: app and api are both on localhost, where a host-only cookie reaches every port, so no
// Domain. When they are sibling subdomains, SESSION_COOKIE_DOMAIN must be the shared parent.
function sessionCookieOptions(): CookieOptions {
	return {
		httpOnly: true,
		sameSite: 'lax',
		path: '/',
		secure: useSecureCookies(),
		...(env.SESSION_COOKIE_DOMAIN ? {domain: env.SESSION_COOKIE_DOMAIN} : {}),
	};
}

/**
 * Same rules as the login page's `sanitizeCallbackUrl`: only same-site paths. `/foo` is fine;
 * `//evil.com`, absolute URLs, and backslash variants that browsers normalize to `//` are not.
 */
export function sanitizeCallbackUrl(raw: string | undefined): string | undefined {
	if (!raw) {
		return undefined;
	}

	if (!raw.startsWith('/')) {
		return undefined;
	}

	if (raw.startsWith('//') || raw.startsWith('/\\')) {
		return undefined;
	}

	return raw;
}

/** The login page maps the `error` param to user-facing copy. */
export function redirectToLoginError(res: Response, appUrl: string, error: string): void {
	res.redirect(`${appUrl}/login?error=${error}`);
}

/**
 * Constant-time string equality for secrets (OAuth state, HMAC signatures). Compares the length
 * first — `timingSafeEqual` throws on unequal-length buffers — which leaks only the length.
 */
export function timingSafeEqualString(a: string, b: string): boolean {
	const ab = Buffer.from(a, 'utf8');
	const bb = Buffer.from(b, 'utf8');
	if (ab.length !== bb.length) {
		return false;
	}

	return timingSafeEqual(ab, bb);
}

export function queryParam(req: Request, name: string): string | null {
	const value = req.query[name];
	if (typeof value !== 'string' || !value) {
		return null;
	}

	return value;
}

/** Signs the browser in: a Session row and the cookie pointing at it. */
export async function establishSession(res: Response, userId: string): Promise<Result<void, ApiError>> {
	const sessionToken = randomBytes(32).toString('hex');
	const expires = new Date(Date.now() + sessionMaxAgeSeconds * 1000);
	const sessionResult = await createSession({sessionToken, userId, expires});
	if (sessionResult.isOk()) {
		res.cookie(sessionCookieName(), sessionToken, {...sessionCookieOptions(), expires});
	}

	return sessionResult;
}

/** The shared tail of every sign-in and sign-up: the session, then back to the app. */
export async function establishSessionAndRedirect(res: Response, args: {appUrl: string; callbackUrl: string; userId: string}): Promise<void> {
	const {appUrl, callbackUrl, userId} = args;
	const sessionResult = await establishSession(res, userId);
	if (sessionResult.isErr()) {
		log.error('Sign-in failed to create session', serializeError(sessionResult.error));
		redirectToLoginError(res, appUrl, 'Callback');
		return;
	}

	res.redirect(`${appUrl}${callbackUrl}`);
}

// Clearing only works with the same name, path and domain the cookie was set with.
export function clearSessionCookie(res: Response): void {
	res.clearCookie(sessionCookieName(), sessionCookieOptions());
}
