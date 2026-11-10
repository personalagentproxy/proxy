import type {Result} from 'ts-results-es';

import type {HarnessAuth, HarnessBackend} from '@proxy/backends/harness/backend';
import type {ApiError} from '@proxy/utils';
import type {ClaudeUsage} from '@proxy/db/claude-account';

import type {ClaudeCredential} from '../me/claude-credential';
import {SIGN_IN_EXPIRED} from '../me/claude-token';

/**
 * Which harness runs a thread's turns (@proxy/backends/harness), of those this server has: the
 * api's own loop over OpenRouter, where there is a key for it, and the Claude Agent SDK's, which
 * runs as the member, on the Claude credential they connected on the Account page. A thread
 * that a harness has run already stays with it, since the session the harness kept on the thread
 * is its alone; a new thread goes to the SDK harness where the member has a Claude credential and
 * the server has the harness, and to the proxy harness otherwise. A member who chose their
 * subscription is never quietly moved to the server's key when their credential can't be had,
 * which would bill the organization for what they meant to pay for themselves: the turn is
 * answered with what to do instead. The credential is read only where the choice turns on it, so
 * a server without the SDK harness never looks for one.
 */

/** The harnesses this server has, by what each is; null for one it hasn't got. */
export type HarnessRegistry = {proxy: HarnessBackend | null; claudeAgentSdk: HarnessBackend | null};

/**
 * How a member's Claude credential is read, and what a turn on it tells the account: that the
 * model turned it down, and what the provider said of the plan. The api's own
 * (me/claude-credential.ts), or a test's.
 */
export type ClaudeCredentials = {
	claudeCredentialFor: (userId: string) => Promise<Result<ClaudeCredential | null, ApiError>>;
	markRefused: (userId: string) => Promise<Result<void, ApiError>>;
	recordUsage: (userId: string, usage: ClaudeUsage) => Promise<Result<void, ApiError>>;
};

/** What the worker runs turns with: the harnesses, and how a member's credential is read, which the choice between them turns on. */
export type Harnesses = {registry: HarnessRegistry; credentials: ClaudeCredentials};

/** The harness for a turn with the credential to give it, or none, with what the person is told instead. */
export type HarnessChoice = {harness: HarnessBackend; auth: HarnessAuth | null} | {harness: null; auth: null; why: string};

export const NOT_SET_UP = 'Chat is not set up on this server: it needs an OpenRouter key (OPENROUTER_KEY). Everything else works as before.';

// What the person is told where the thread's harness is one this server hasn't got.
function notOnThisServer(harness: string): string {
	return `This conversation runs on the ${harness} harness, which this server hasn’t got. Everything else works as before.`;
}

/** The credential as the harness is handed it: a token goes as a sign-in's access token would, with no scopes, which is how the SDK takes `CLAUDE_CODE_OAUTH_TOKEN`. */
export function authFor(credential: ClaudeCredential): HarnessAuth {
	if (credential.kind === 'setup_token') {
		return {kind: 'oauth', accessToken: credential.token, scopes: []};
	}
	return {kind: 'api_key', key: credential.key};
}

/** Whether the choice for the thread turns on the member's credential: the SDK harness is here, and the thread isn't another's already. */
export function needsCredential(registry: HarnessRegistry, thread: {harness: string | null}): boolean {
	if (registry.claudeAgentSdk === null) {
		return false;
	}
	return thread.harness === null || thread.harness === registry.claudeAgentSdk.id;
}

// The harness the thread stays with, by the id it recorded; with the member's credential where it
// is the SDK harness, which can't run without one.
function recorded(registry: HarnessRegistry, harness: string, credential: ClaudeCredential | null): HarnessChoice {
	const found = [registry.proxy, registry.claudeAgentSdk].find((candidate) => candidate?.id === harness) ?? null;
	if (found === null) {
		return {harness: null, auth: null, why: notOnThisServer(harness)};
	}
	if (found !== registry.claudeAgentSdk) {
		return {harness: found, auth: null};
	}
	if (credential === null) {
		return {harness: null, auth: null, why: SIGN_IN_EXPIRED};
	}
	return {harness: found, auth: authFor(credential)};
}

/**
 * The harness for a turn on the thread: the one the thread recorded, where it has; else the SDK
 * harness where the member has a Claude credential and the server has the harness; else the proxy
 * harness. `credential` is the member's, or null where they connected none, or it wasn't looked
 * for (`needsCredential`).
 */
export function harnessFor(registry: HarnessRegistry, thread: {harness: string | null}, credential: ClaudeCredential | null): HarnessChoice {
	if (thread.harness !== null) {
		return recorded(registry, thread.harness, credential);
	}
	if (credential !== null && registry.claudeAgentSdk !== null) {
		return {harness: registry.claudeAgentSdk, auth: authFor(credential)};
	}
	if (registry.proxy !== null) {
		return {harness: registry.proxy, auth: null};
	}
	return {harness: null, auth: null, why: NOT_SET_UP};
}
