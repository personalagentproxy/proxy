import {magicLinkResponseSchema, signInMethodsSchema} from '@proxy/contracts/auth';
import {httpRequest} from '@proxy/utils';
import {apiRequest, apiSend} from '@/client/request';

/**
 * Requests a magic-link email. Pre-auth, so no session cookie; the api still requires the app's
 * Origin (CSRF guard), which the browser attaches. Any status is accepted so the error body
 * (`magicLinkResponseSchema`) is parsed as an answer, which is why this one call goes to
 * `httpRequest` itself: `apiRequest` takes a 4xx/5xx as an error, unparsed.
 */
export function requestMagicLink(email: string, callbackUrl?: string) {
	return httpRequest(
		'/auth/email',
		{
			method: 'POST',
			headers: {'Content-Type': 'application/json'},
			body: JSON.stringify({email, ...(callbackUrl ? {callbackUrl} : {})}),
		},
		{schema: magicLinkResponseSchema, allowStatus: () => true},
	);
}

/**
 * The sign-in methods the api has set up besides the magic link, which always is, and which of
 * what integrations need it has (`needs`), for the catalog.
 */
export function getSignInMethods() {
	return apiRequest('GET', '/auth/methods', signInMethodsSchema);
}

/** The full-page navigation that starts Google sign-in; the api redirects back when done. */
export function googleSignInUrl(callbackUrl?: string): string {
	const query = callbackUrl ? `?callbackUrl=${encodeURIComponent(callbackUrl)}` : '';
	return `/auth/google${query}`;
}

/**
 * Deletes the session and clears its cookie, then reloads: the reloaded page finds no session
 * and its guard sends the user to /login. Reloads even if the request failed, at worst leaving
 * them signed in where they were.
 */
export async function signOut(): Promise<void> {
	const result = await apiSend('POST', '/auth/signout');
	if (result.isErr()) {
		console.warn('Sign-out request failed', result.error.kind);
	}

	window.location.reload();
}

/** Dev only: signs in as the dev user, made on its first sign-in. The api 404s outside development. */
export function devLogin() {
	return apiSend('POST', '/auth/dev/login');
}
