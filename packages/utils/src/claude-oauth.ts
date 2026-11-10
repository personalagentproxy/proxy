import {createHash, randomBytes} from 'node:crypto';

import {Err, Ok, type Result} from 'ts-results-es';
import {z} from 'zod';

import {ApiErr, type ApiError} from './api-error';
import {type FetchError, httpRequest} from './fetch';

/**
 * The mint `claude setup-token` does, for the desktop app to do from the person's machine: Claude
 * Code's public OAuth client with PKCE, Claude's manual code page as the redirect, where the person
 * is shown a code and pastes it back, and the code traded for one long-lived token, good for a
 * year, with the inference scope alone, which the api stores as it would a pasted setup token.
 * The api never mints or refreshes a token: it only ever holds what was minted here or pasted.
 * Unlike the connect flow's providers, the token endpoint takes the `state` in its body too, and
 * the pasted code carries it after a `#`. Here are the constants and the pure pieces: PKCE, the
 * sign-in page's address, reading the pasted code, and the exchange.
 */

export const AUTHORIZE_URL = 'https://claude.com/cai/oauth/authorize';
export const TOKEN_URL = 'https://platform.claude.com/v1/oauth/token';
export const REDIRECT_URI = 'https://platform.claude.com/oauth/code/callback';
/** Claude Code's public OAuth client, which every `claude` install signs in with. */
export const CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';
/** The inference scope alone: the token runs the model, and nothing else of the account is asked for. */
export const SCOPES = ['user:inference'];
/** How long the token is asked to last, as `claude setup-token` asks: a year. */
export const ONE_YEAR_SECONDS = 31_536_000;

const REQUEST_TIMEOUT_MS = 8_000;

export const SIGN_IN_FAILED = 'Claude sign-in failed. Try again.';
export const INCOMPLETE_CODE = 'Paste the complete code from Claude.';
export const OTHER_ATTEMPT_CODE =
	'This code is from a different sign-in attempt. Open Claude again and paste the new code.';

/** A PKCE verifier and the challenge the provider is sent in its place. */
export function makePkce(): {verifier: string; challenge: string} {
	const verifier = randomBytes(32).toString('base64url');
	return {verifier, challenge: createHash('sha256').update(verifier).digest('base64url')};
}

/** Claude's sign-in page for this attempt: it shows a code bound to `state` once the person agrees. */
export function authorizeUrl({challenge, state}: {challenge: string; state: string}): string {
	const url = new URL(AUTHORIZE_URL);
	url.searchParams.set('code', 'true');
	url.searchParams.set('client_id', CLIENT_ID);
	url.searchParams.set('response_type', 'code');
	url.searchParams.set('redirect_uri', REDIRECT_URI);
	url.searchParams.set('scope', SCOPES.join(' '));
	url.searchParams.set('code_challenge', challenge);
	url.searchParams.set('code_challenge_method', 'S256');
	url.searchParams.set('state', state);
	return url.toString();
}

/**
 * The code out of what the person pasted, `<code>#<state>`, once its state is the attempt's; the
 * last `#` splits it, should the code hold one.
 */
export function parsePastedCode(pasted: string, expectedState: string): Result<string, ApiError> {
	const trimmed = pasted.trim();
	const at = trimmed.lastIndexOf('#');
	if (at === -1) {
		return Err(ApiErr.validationError(INCOMPLETE_CODE));
	}
	const code = trimmed.slice(0, at);
	const state = trimmed.slice(at + 1);
	if (code === '' || state === '') {
		return Err(ApiErr.validationError(INCOMPLETE_CODE));
	}
	if (state !== expectedState) {
		return Err(ApiErr.validationError(OTHER_ATTEMPT_CODE));
	}
	return Ok(code);
}

// The token endpoint's answer: a refresh token may come with it, and is dropped, since nothing
// here ever refreshes.
const tokenResponseSchema = z.object({
	access_token: z.string(),
	expires_in: z.number(),
	scope: z.string().optional(),
});

/** What the mint gives: the token, and when Claude said it ends. */
export type MintedToken = {token: string; expiresAt: Date};

/**
 * The pasted code traded for the token, with the PKCE verifier and the state the attempt began
 * with, asking for a year's token as `claude setup-token` does.
 */
export async function exchangeCode({
	code,
	verifier,
	state,
}: {
	code: string;
	verifier: string;
	state: string;
}): Promise<Result<MintedToken, ApiError>> {
	const body = {
		grant_type: 'authorization_code',
		code,
		redirect_uri: REDIRECT_URI,
		client_id: CLIENT_ID,
		code_verifier: verifier,
		state,
		expires_in: ONE_YEAR_SECONDS,
	};
	const answered: Result<z.infer<typeof tokenResponseSchema>, FetchError> = await httpRequest(
		TOKEN_URL,
		{
			method: 'POST',
			headers: {'Content-Type': 'application/json', Accept: 'application/json'},
			body: JSON.stringify(body),
		},
		{schema: tokenResponseSchema, timeoutMs: REQUEST_TIMEOUT_MS},
	);
	if (answered.isErr()) {
		if (answered.error.kind === 'http') {
			return Err(ApiErr.unavailable(SIGN_IN_FAILED));
		}
		return Err(ApiErr.providerUnreachable(answered.error, SIGN_IN_FAILED));
	}
	const {access_token, expires_in} = answered.value;
	return Ok({token: access_token, expiresAt: new Date(Date.now() + expires_in * 1000)});
}
