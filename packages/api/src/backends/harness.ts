import type {Result} from 'ts-results-es';

import type {HarnessAuth, HarnessBackend} from '@proxy/backends/harness/backend';
import type {ApiError} from '@proxy/utils';
import type {EntryAttachment, EntryImage} from '@proxy/utils/harness-context';
import type {SignedInAgent} from '@proxy/db/agent';
import type {ClaudeUsage} from '@proxy/db/claude-account';
import type {PersonaModel} from '@proxy/db/harness';

import type {ClaudeCredential} from '../me/claude-credential';

/**
 * Which harness runs a thread's turns (@proxy/backends/harness), of those this server has: the
 * api's own loop over OpenRouter, where there is a key for it, and the Claude Agent SDK's, which
 * runs as the member, on the Claude credential they connected on the Account page. The choice is
 * the persona's, made where it is made or changed, with the model it answers with, one of those
 * the harness lists; its sub-agents' turns go the same way. It is read anew for each turn, so a
 * persona switched to another harness moves every member's conversation with it from the next
 * turn on: the log is the record on either, and a harness whose session the thread hasn't got is
 * given the log in its place. A harness the server hasn't got, as the SDK harness on a server
 * that turned it off, is read as the first it has, and a model the harness hasn't got as its
 * first. A persona on the SDK harness needs each member's own credential: a member without one
 * is told to connect it, and one whose credential ran out or was refused to connect it again
 * (inference.ts), never quietly moved to the server's key, which would bill the organization for
 * what the persona was set to bill them. The credential is read only where the choice turns on it.
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

/**
 * A picture the person attached, as a model is given it: read from where the file is kept and
 * made small enough to send; null for a file that is no picture, or one that can't be read as one.
 */
export type PictureOf = (attachment: EntryAttachment) => Promise<Result<EntryImage | null, ApiError>>;

/**
 * The files an answer of the agent's shows the person, as pictures among its words (`![what it
 * shows](link)`), each at the version it holds as the answer is written: those of a drive the
 * agent, as the member it acts for, may read. A picture of anything else is left a link.
 */
export type PinnedIn = (agent: SignedInAgent, text: string) => Promise<Result<EntryAttachment[], ApiError>>;

/** What the worker runs turns with: the harnesses, how a member's credential is read, which the choice between them turns on, how a picture the person attached is read for a model that sees pictures, without which no turn is given any, and how the files an answer shows are kept with it, without which none is. */
export type Harnesses = {registry: HarnessRegistry; credentials: ClaudeCredentials; picture?: PictureOf; pinned?: PinnedIn};

/** The harness for a turn with the model to answer with and the credential to give it, or none, with what the person is told instead. */
export type HarnessChoice = {harness: HarnessBackend; model: string; auth: HarnessAuth | null} | {harness: null; auth: null; why: string};

export const NOT_SET_UP = 'Chat is not set up on this server: it needs an OpenRouter key (OPENROUTER_KEY). Everything else works as before.';

/** The credential as the harness is handed it: a token goes as a sign-in's access token would, with no scopes, which is how the SDK takes `CLAUDE_CODE_OAUTH_TOKEN`. */
export function authFor(credential: ClaudeCredential): HarnessAuth {
	if (credential.kind === 'setup_token') {
		return {kind: 'oauth', accessToken: credential.token, scopes: []};
	}
	return {kind: 'api_key', key: credential.key};
}

/** What the person is told where the persona runs on their own Claude account and they connected none. */
export const CONNECT_CLAUDE = 'This agent runs on your own Claude account, and you haven’t connected one. Connect it under Claude on the Account page.';

/** The harnesses this server has, in the order a choice among them is offered: the first is what a persona gets that chose none, or one the server hasn't got. */
export function harnessesOf(registry: HarnessRegistry): HarnessBackend[] {
	return [registry.proxy, registry.claudeAgentSdk].flatMap((harness) => (harness === null ? [] : [harness]));
}

/**
 * The persona's choice as this server has it: the harness it chose, or the first the server has
 * where it hasn't got that one, with the model it chose of that harness's, or the harness's first.
 * Null on a server with no harness at all.
 */
export function chosenFor(registry: HarnessRegistry, persona: PersonaModel): {harness: HarnessBackend; model: string} | null {
	const harnesses = harnessesOf(registry);
	const harness = harnesses.find((candidate) => candidate.id === persona.harness) ?? harnesses[0];
	if (harness === undefined) {
		return null;
	}
	const model = harness.models.find((candidate) => candidate.id === persona.chatModel) ?? harness.models[0];
	return {harness, model: model.id};
}

/** Whether the harness runs as the member, on their own credential: the SDK harness. */
export function needsCredential(registry: HarnessRegistry, harness: HarnessBackend): boolean {
	return harness === registry.claudeAgentSdk;
}

/**
 * The harness for a turn of the member's with the persona, and the model: the persona's choice as
 * the server has it (`chosenFor`), with the member's credential where the harness runs on it, and
 * what to tell them where they connected none. `credential` is the member's, or null where they
 * connected none, or it wasn't looked for (`needsCredential`).
 */
export function harnessFor(registry: HarnessRegistry, persona: PersonaModel, credential: ClaudeCredential | null): HarnessChoice {
	const chosen = chosenFor(registry, persona);
	if (chosen === null) {
		return {harness: null, auth: null, why: NOT_SET_UP};
	}
	if (!needsCredential(registry, chosen.harness)) {
		return {...chosen, auth: null};
	}
	if (credential === null) {
		return {harness: null, auth: null, why: CONNECT_CLAUDE};
	}
	return {...chosen, auth: authFor(credential)};
}

/**
 * The harness whose turns one process runs only so many of at once, each a subprocess of the SDK
 * harness's, and how many: the harness's cap, which the worker keeps to as it claims jobs. Null
 * where the server hasn't got the harness, or it has no cap.
 */
export function cappedHarness(registry: HarnessRegistry): {harness: string; turns: number} | null {
	const harness = registry.claudeAgentSdk;
	if (harness === null || harness.maxConcurrentTurns === undefined) {
		return null;
	}
	return {harness: harness.id, turns: harness.maxConcurrentTurns};
}
