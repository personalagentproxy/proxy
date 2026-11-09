import {Err, Ok, type Result} from 'ts-results-es';
import {z} from 'zod';

import {type ApiError, Do} from '@proxy/utils';
import {type ClaudeAccountRow, type ClaudeAccountUpdate, updateClaudeAccountLocked} from '@proxy/db/claude-account';

import {log} from '../observability/log';
import {encryptSecret} from '../utils/secret-crypto';
import {readStoredJson} from '../utils/stored-json';
import {type OauthCredential, refreshCredential} from './claude-oauth';

/**
 * The credential the built-in agent runs under for a member, as the rest of the api asks for it:
 * a sign-in's access token, good for at least a few minutes, refreshed here when it isn't, with the
 * account's row locked so two workers or instances never refresh one refresh token at once; a setup
 * token or an API key as pasted. A refresh that was refused is noted on the account, for the
 * Account page to say so, and comes back as the error until the person connects again.
 */

export type ClaudeCredential = {kind: 'oauth'; accessToken: string; scopes: string[]} | {kind: 'setup_token'; token: string} | {kind: 'api_key'; key: string};

// An access token with less than this left is refreshed before it is handed out, so a turn that
// starts on it isn't cut short.
const REFRESH_WITHIN_MS = 5 * 60 * 1000;

/** What the credential column holds for a sign-in, as JSON. */
export const storedOauthSchema = z.object({
	accessToken: z.string(),
	refreshToken: z.string(),
	expiresAt: z.iso.datetime(),
	scopes: z.array(z.string()),
});

const storedTokenSchema = z.object({token: z.string()});
const storedKeySchema = z.object({key: z.string()});

/** A sign-in's tokens as the credential column stores them, encrypted. */
export function encryptOauthCredential(credential: OauthCredential): Result<string, ApiError> {
	const stored: z.infer<typeof storedOauthSchema> = {
		accessToken: credential.accessToken,
		refreshToken: credential.refreshToken,
		expiresAt: credential.expiresAt.toISOString(),
		scopes: credential.scopes,
	};
	return encryptSecret(JSON.stringify(stored));
}

type Outcome = {update: ClaudeAccountUpdate; value: Result<ClaudeCredential, ApiError>};

function unchanged(value: Result<ClaudeCredential, ApiError>): Outcome {
	return {update: null, value};
}

// A sign-in's access token: as stored while it has time left, else refreshed and the rotated pair
// stored in its place.
async function oauthCredential(row: ClaudeAccountRow, forceRefresh: boolean): Promise<Outcome> {
	const stored = readStoredJson(row.credential, storedOauthSchema);
	if (stored.isErr()) {
		return unchanged(Err(stored.error));
	}
	const current: OauthCredential = {...stored.value, expiresAt: new Date(stored.value.expiresAt)};
	if (!forceRefresh && current.expiresAt.getTime() - Date.now() > REFRESH_WITHIN_MS) {
		return unchanged(Ok({kind: 'oauth', accessToken: current.accessToken, scopes: current.scopes}));
	}
	const refreshed = await refreshCredential(current);
	if (refreshed.isErr()) {
		if (refreshed.error.kind !== 'unavailable') {
			return unchanged(Err(refreshed.error));
		}
		log.warn('Refreshing a Claude sign-in was refused', {userId: row.userId});
		return {update: {failedAt: new Date(), failure: refreshed.error.message}, value: Err(refreshed.error)};
	}
	const encrypted = encryptOauthCredential(refreshed.value);
	if (encrypted.isErr()) {
		return unchanged(Err(encrypted.error));
	}
	return {
		update: {credential: encrypted.value, expiresAt: refreshed.value.expiresAt, lastRefreshedAt: new Date()},
		value: Ok({kind: 'oauth', accessToken: refreshed.value.accessToken, scopes: refreshed.value.scopes}),
	};
}

function pastedCredential(row: ClaudeAccountRow): Outcome {
	if (row.kind === 'setup_token') {
		return unchanged(readStoredJson(row.credential, storedTokenSchema).map(({token}) => ({kind: 'setup_token', token})));
	}
	return unchanged(readStoredJson(row.credential, storedKeySchema).map(({key}) => ({kind: 'api_key', key})));
}

/**
 * The member's Claude credential, ready to use, or null when they connected none. `forceRefresh`
 * refreshes a sign-in's access token however much time it has left, for a turn Claude refused the
 * token of.
 */
export function claudeCredentialFor(userId: string, options: {forceRefresh?: boolean} = {}): Promise<Result<ClaudeCredential | null, ApiError>> {
	return Do(async ($) => {
		const outcome = $(
			await updateClaudeAccountLocked(userId, async (row): Promise<Outcome> => {
				if (row.kind === 'oauth') {
					return oauthCredential(row, options.forceRefresh === true);
				}
				return pastedCredential(row);
			}),
		);
		if (outcome === null) {
			return null;
		}
		return $(outcome);
	});
}
