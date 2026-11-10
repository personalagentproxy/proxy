import type {Result} from 'ts-results-es';

import type {HarnessAuth, HarnessBackend} from '@proxy/backends/harness/backend';
import type {ApiError} from '@proxy/utils';
import type {ClaudeUsage} from '@proxy/db/claude-account';

import type {ClaudeCredential} from '../me/claude-credential';

/**
 * Which harness runs a thread's turns (@proxy/backends/harness), of those this server has: the
 * api's own loop over OpenRouter, where there is a key for it, and the Claude Agent SDK's, which
 * runs as the member, on the Claude credential they connected on the Account page. The choice is
 * the member's credential's, made anew for each turn: with one, their turns run on the SDK
 * harness, where the server has it, and on the proxy harness otherwise, as they do again once the
 * member disconnects or the server turns the SDK harness off. A thread therefore moves between the
 * two with the credential: the log is the record on either, and a harness whose session the
 * thread hasn't got is given the log in its place. A member who chose their subscription is never
 * quietly moved to the server's key when their credential can't be had, run out or refused, which
 * would bill the organization for what they meant to pay for themselves: the turn is answered with
 * what to do instead (inference.ts). The credential is read only where the choice turns on it, so
 * a server without the SDK harness never looks for one.
 */

/** The harnesses this server has, by what each is; null for one it hasn't got. */
export type HarnessRegistry = {proxy: HarnessBackend | null; claudeAgentSdk: HarnessBackend | null};

/**
 * How a member's Claude credential is read, and what a turn on it tells the account: that the
 * model turned it down, after which it isn't handed out until the member connects again, and what
 * the provider said of the plan. The api's own
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

/** The credential as the harness is handed it: a token goes as a sign-in's access token would, with no scopes, which is how the SDK takes `CLAUDE_CODE_OAUTH_TOKEN`. */
export function authFor(credential: ClaudeCredential): HarnessAuth {
	if (credential.kind === 'setup_token') {
		return {kind: 'oauth', accessToken: credential.token, scopes: []};
	}
	return {kind: 'api_key', key: credential.key};
}

/** Whether the choice turns on the member's credential: the SDK harness is here. */
export function needsCredential(registry: HarnessRegistry): boolean {
	return registry.claudeAgentSdk !== null;
}

/**
 * The harness for a turn of the member's: the SDK harness where they have a Claude credential and
 * the server has the harness; else the proxy harness. `credential` is the member's, or null where
 * they connected none, or it wasn't looked for (`needsCredential`).
 */
export function harnessFor(registry: HarnessRegistry, credential: ClaudeCredential | null): HarnessChoice {
	if (credential !== null && registry.claudeAgentSdk !== null) {
		return {harness: registry.claudeAgentSdk, auth: authFor(credential)};
	}
	if (registry.proxy !== null) {
		return {harness: registry.proxy, auth: null};
	}
	return {harness: null, auth: null, why: NOT_SET_UP};
}

/**
 * How many turns on members' own accounts one process runs at once, each a subprocess of the SDK
 * harness's: the harness's cap, which the worker keeps to as it claims jobs; null where the server
 * hasn't got the harness, or it has no cap.
 */
export function ownAccountTurnCap(registry: HarnessRegistry): number | null {
	return registry.claudeAgentSdk?.maxConcurrentTurns ?? null;
}
