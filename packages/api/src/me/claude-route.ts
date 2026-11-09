import {randomBytes} from 'node:crypto';

import type {Response} from 'express';
import {Err, type Result} from 'ts-results-es';
import {z} from 'zod';

import {ApiErr, type ApiError, Do, parseCookieHeader, parseSchema} from '@proxy/utils';
import {type ClaudeAccountRow, deleteClaudeAccount, getClaudeAccount, upsertClaudeAccount} from '@proxy/db/claude-account';
import {type ClaudeAccount, type ClaudeSignIn, claudeCodeBodySchema, claudeTokenBodySchema} from '@proxy/contracts/me';

import {timingSafeEqualString, useSecureCookies} from '../auth/session';
import {makePkce} from '../connections/connect-flow';
import {log} from '../observability/log';
import type {AuthenticatedRequest} from '../server/middleware/require-auth';
import {sendResult} from '../server/response';
import {encryptSecret} from '../utils/secret-crypto';
import {readStoredJson} from '../utils/stored-json';
import {encryptOauthCredential} from './claude-credential';
import {authorizeUrl, classifyPastedToken, exchangeCode, parsePastedCode} from './claude-oauth';

/**
 * The Account page's Claude card: the member's own Claude account, which the built-in agent runs
 * under for them. Connecting a subscription is a sign-in begun here (`claude-oauth.ts`), its
 * handshake kept in an encrypted cookie for a quarter of an hour as the connect flow keeps its
 * own, and finished with the code the person pastes back; a setup token or an API key is pasted
 * as it is. What comes back to the page is the kind, the account and the expiry, never the
 * credential, which is stored encrypted and read only where the agent runs.
 */

const stateCookieName = 'proxy.claude-state';
const stateCookieMaxAgeMs = 15 * 60 * 1000;
// Only sent to these routes.
const stateCookiePath = '/api/me/claude';

const statePayloadSchema = z.object({state: z.string(), verifier: z.string(), userId: z.string()});

type StatePayload = z.infer<typeof statePayloadSchema>;

function stateCookieOptions() {
	return {httpOnly: true, sameSite: 'lax' as const, secure: useSecureCookies(), path: stateCookiePath};
}

const NO_SIGN_IN = 'No Claude sign-in is under way. Open Claude again and paste the new code.';

function readStateCookie(request: AuthenticatedRequest): Result<StatePayload, ApiError> {
	const cookie = parseCookieHeader(request.headers.cookie ?? '').get(stateCookieName);
	if (cookie === undefined) {
		return Err(ApiErr.validationError(NO_SIGN_IN));
	}
	const payload = readStoredJson(cookie, statePayloadSchema);
	if (payload.isErr()) {
		return Err(ApiErr.validationError(NO_SIGN_IN));
	}
	if (!timingSafeEqualString(payload.value.userId, request.user.userId)) {
		return Err(ApiErr.validationError(NO_SIGN_IN));
	}
	return payload;
}

// The card's view of the account: never the credential.
function describe(row: ClaudeAccountRow | null): ClaudeAccount {
	if (!row) {
		return {account: null};
	}
	return {
		account: {
			kind: row.kind,
			email: row.email,
			subscriptionType: row.subscriptionType,
			expiresAt: row.expiresAt?.toISOString() ?? null,
			failure: row.failure,
			connectedAt: row.createdAt.toISOString(),
		},
	};
}

/** `GET /api/me/claude` — how the member's Claude account is connected, or `null`. */
export function handleGetClaudeAccountRoute(request: AuthenticatedRequest): Promise<Result<ClaudeAccount, ApiError>> {
	return Do(async ($) => describe($(await getClaudeAccount(request.user.userId))));
}

/**
 * `POST /api/me/claude/sign-in` — begins a sign-in to the member's Claude subscription: the
 * handshake goes in the cookie, and the answer is Claude's sign-in page, for the web app to open.
 */
export async function handleClaudeSignInRoute(request: AuthenticatedRequest, res: Response): Promise<void> {
	const begun = Do<ClaudeSignIn, ApiError>(($) => {
		const state = randomBytes(16).toString('hex');
		const {verifier, challenge} = makePkce();
		const payload: StatePayload = {state, verifier, userId: request.user.userId};
		const cookie = $(encryptSecret(JSON.stringify(payload)));
		res.cookie(stateCookieName, cookie, {...stateCookieOptions(), maxAge: stateCookieMaxAgeMs});
		return {authorizeUrl: authorizeUrl({challenge, state})};
	});
	sendResult(res, begun);
}

/**
 * `POST /api/me/claude/code` — finishes the sign-in with the code Claude showed, pasted as it
 * was: checked against the handshake, traded for the tokens, which are stored encrypted. The
 * handshake is single-use: cleared however this ends.
 */
export async function handleClaudeCodeRoute(request: AuthenticatedRequest, res: Response): Promise<void> {
	const connected = await Do<ClaudeAccount, ApiError>(async ($) => {
		const {code: pasted} = $(parseSchema(claudeCodeBodySchema, request.body));
		const payload = $(readStateCookie(request));
		res.clearCookie(stateCookieName, stateCookieOptions());
		const code = $(parsePastedCode(pasted, payload.state));
		const credential = $(await exchangeCode({code, verifier: payload.verifier, state: payload.state}));
		const encrypted = $(encryptOauthCredential(credential));
		const row = $(await upsertClaudeAccount(request.user.userId, {kind: 'oauth', credential: encrypted, expiresAt: credential.expiresAt}));
		log.info('Connected a Claude subscription', {userId: request.user.userId});
		return describe(row);
	});
	sendResult(res, connected);
}

/** `POST /api/me/claude/token` — connects a `claude setup-token` value or an Anthropic API key, as pasted. */
export function handleClaudeTokenRoute(request: AuthenticatedRequest): Promise<Result<ClaudeAccount, ApiError>> {
	return Do(async ($) => {
		const {token} = $(parseSchema(claudeTokenBodySchema, request.body));
		const kind = $(classifyPastedToken(token));
		const stored = kind === 'setup_token' ? {token} : {key: token};
		const encrypted = $(encryptSecret(JSON.stringify(stored)));
		const row = $(await upsertClaudeAccount(request.user.userId, {kind, credential: encrypted}));
		log.info('Connected a Claude account with a pasted token', {userId: request.user.userId, kind});
		return describe(row);
	});
}

/** `DELETE /api/me/claude` — disconnects the member's Claude account. */
export function handleDeleteClaudeAccountRoute(request: AuthenticatedRequest): Promise<Result<ClaudeAccount, ApiError>> {
	return Do(async ($) => {
		$(await deleteClaudeAccount(request.user.userId));
		log.info('Disconnected a Claude account', {userId: request.user.userId});
		return {account: null};
	});
}
