import {createHash, randomBytes} from 'node:crypto';

import {session} from 'electron';
import {Err, Ok, Result} from 'ts-results-es';

import {APP_URL} from './env';

// Signing in, with the browser (packages/api/src/auth/desktop.ts): the app keeps a PKCE verifier
// and sends the browser its challenge; the browser comes back, through the app's link, with a
// one-time code bound to it; the app trades code and verifier for a session cookie. The verifier
// never leaves this process, so another app that got hold of the link could not redeem the code.

let verifier: string | null = null;

/** Where the browser signs in: the login page, coming back to /desktop-auth with the challenge. */
export function beginSignIn(): string {
	verifier = randomBytes(32).toString('base64url');
	const challenge = createHash('sha256').update(verifier).digest('base64url');
	const callbackUrl = `/desktop-auth?challenge=${challenge}`;

	return `${APP_URL}/login?callbackUrl=${encodeURIComponent(callbackUrl)}`;
}

/**
 * Trades the code from the link, with the verifier, for a session: the api answers with the
 * cookie, which the window's session keeps, so the app is signed in as a browser is. `Err` has
 * what to tell the person.
 */
export async function finishSignIn(code: string): Promise<Result<void, string>> {
	if (!verifier) {
		return Err('This sign-in was begun by another run of the app. Sign in again.');
	}

	// The window's session makes the request, so the cookie the api sets lands where the app's
	// pages read it. It follows the system's proxy settings too, as the window does.
	const response = await Result.wrapAsync<Response, Error>(() =>
		session.defaultSession.fetch(`${APP_URL}/auth/desktop/session`, {
			method: 'POST',
			headers: {'Content-Type': 'application/json'},
			body: JSON.stringify({code, verifier}),
			credentials: 'include',
		}),
	);
	if (response.isErr()) {
		// The api was never reached, so the code is still good: the verifier stays for a retry.
		return Err('Personal Agent Proxy could not be reached. Check your connection and try again.');
	}

	// The api has seen the code, and decided; the verifier is spent either way.
	verifier = null;
	if (!response.value.ok) {
		return Err('Signing in did not work. Sign in again.');
	}

	return Ok(undefined);
}
