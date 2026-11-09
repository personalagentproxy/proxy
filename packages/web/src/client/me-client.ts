import {
	claudeAccountSchema,
	claudeSignInSchema,
	type claudeCodeBodySchema,
	type claudeTokenBodySchema,
	meSchema,
	sessionsSchema,
} from '@proxy/contracts/me';
import type {z} from 'zod';
import {apiRequest, apiSend} from '@/client/request';

/** Who is signed in (`GET /api/me`). A 401 means "redirect to /login". The organizations they are in are `listOrgs`. */
export function getMe() {
	return apiRequest('GET', '/api/me', meSchema);
}

/**
 * Deletes the account: every connection in the organizations the person owns is undone at its
 * provider, then the user and those organizations go; the session goes with them.
 */
export function deleteAccount() {
	return apiSend('DELETE', '/api/me');
}

/** Every browser and desktop app the person is signed in on, this one marked `current`. */
export function listSessions() {
	return apiRequest('GET', '/api/me/sessions', sessionsSchema);
}

/** Signs one of the person's other sessions out; this one signs out with `signOut`. */
export function deleteSession(sessionId: string) {
	return apiSend('DELETE', `/api/me/sessions/${encodeURIComponent(sessionId)}`);
}

/** Signs the person out everywhere but this browser. */
export function deleteOtherSessions() {
	return apiSend('DELETE', '/api/me/sessions/others');
}

/** How the person's own Claude account is connected, for the Account page's card; `account` null for none. */
export function getClaudeAccount() {
	return apiRequest('GET', '/api/me/claude', claudeAccountSchema);
}

/** Begins a sign-in to the person's Claude subscription: Claude's page to open, which shows a code to paste back. */
export function beginClaudeSignIn() {
	return apiRequest('POST', '/api/me/claude/sign-in', claudeSignInSchema);
}

/** Finishes the sign-in with the code Claude showed, pasted as it was. */
export function finishClaudeSignIn(code: string) {
	return apiRequest('POST', '/api/me/claude/code', claudeAccountSchema, {
		code,
	} satisfies z.input<typeof claudeCodeBodySchema>);
}

/** Connects a `claude setup-token` value or an Anthropic API key instead of signing in. */
export function connectClaudeToken(token: string) {
	return apiRequest('POST', '/api/me/claude/token', claudeAccountSchema, {
		token,
	} satisfies z.input<typeof claudeTokenBodySchema>);
}

/** Disconnects the person's Claude account. */
export function disconnectClaude() {
	return apiRequest('DELETE', '/api/me/claude', claudeAccountSchema);
}
