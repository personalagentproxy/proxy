import {randomBytes} from 'node:crypto';

import type {Result} from 'ts-results-es';
import type {ApiError} from '@proxy/utils';
import {
	authorizeUrl,
	type MintedToken,
	makePkce,
	OTHER_ATTEMPT_CODE,
	parsePastedCode,
	SIGN_IN_FAILED,
} from '@proxy/utils/claude-oauth';

// Signing in to Claude for the Account page's Claude card, the mint `claude setup-token` does,
// run here so the token is made on the person's own computer: the page asks for a start, and the
// app opens Claude's sign-in page in the browser with a PKCE challenge and a state of this
// attempt's; Claude shows the person a code, which they paste into the page, and the page hands
// it here, where it is checked against the attempt and traded for a year's token, which goes back
// to the page as plain data for it to connect through the api. The verifier never leaves this
// process. One attempt at a time: a new start replaces the old, whose code is nothing to it then.
// main.ts registers the two handlers with what they need of Electron and the network, so a test
// can drive this with fakes.

/** What the page gets from a start: word that Claude's page was opened, or what went wrong. */
export type StartAnswer = {ok: true} | {error: string};
/** What the page gets from a finish: the token and when it ends, as ISO, or what went wrong. */
export type FinishAnswer = {token: string; expiresAt: string} | {error: string};

export type ClaudeSignIn = {
	start(): Promise<StartAnswer>;
	finish(pasted: string): Promise<FinishAnswer>;
};

type Exchange = (attempt: {
	code: string;
	verifier: string;
	state: string;
}) => Promise<Result<MintedToken, ApiError>>;

// An error's words for the person; the exchange's errors all carry some.
function messageOf(error: ApiError): string {
	if ('message' in error && error.message !== undefined) {
		return error.message;
	}
	return SIGN_IN_FAILED;
}

/**
 * The sign-in, over `openExternal`, which opens Claude's page in the browser, and `exchange`,
 * which trades the code for the token (`exchangeCode` in `@proxy/utils/claude-oauth`).
 */
export function createClaudeSignIn({
	openExternal,
	exchange,
}: {
	openExternal: (url: string) => Promise<void>;
	exchange: Exchange;
}): ClaudeSignIn {
	let attempt: {verifier: string; state: string} | null = null;

	return {
		async start() {
			const {verifier, challenge} = makePkce();
			const state = randomBytes(32).toString('base64url');
			attempt = {verifier, state};
			const opened = await openExternal(authorizeUrl({challenge, state})).then(
				() => null,
				() => SIGN_IN_FAILED,
			);
			if (opened !== null) {
				return {error: opened};
			}
			return {ok: true};
		},

		async finish(pasted) {
			if (attempt === null) {
				return {error: OTHER_ATTEMPT_CODE};
			}
			const code = parsePastedCode(pasted, attempt.state);
			if (code.isErr()) {
				return {error: messageOf(code.error)};
			}
			const minted = await exchange({code: code.value, ...attempt});
			attempt = null;
			if (minted.isErr()) {
				return {error: messageOf(minted.error)};
			}
			return {token: minted.value.token, expiresAt: minted.value.expiresAt.toISOString()};
		},
	};
}
