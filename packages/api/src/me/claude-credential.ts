import {Err, type Result} from 'ts-results-es';
import {z} from 'zod';

import {ApiErr, type ApiError, Do} from '@proxy/utils';
import {type ClaudeAccountRow, type ClaudeUsage, getClaudeAccount, markClaudeAccountFailed, setClaudeAccountUsage} from '@proxy/db/claude-account';

import {log} from '../observability/log';
import {readStoredJson} from '../utils/stored-json';
import {SIGN_IN_EXPIRED} from './claude-token';

/**
 * The credential the built-in agent runs under for a member, as the rest of the api asks for it: a
 * long-lived token or an API key, decrypted from the account's row and handed out as it is. The api
 * refreshes nothing: a token whose end, as the mint reported it, has passed is no good, as is one
 * the model turned down, and either is noted on the account, for the Account page to say so, and
 * comes back as the error until the person connects again. What a turn said of the member's plan
 * is kept on the account too, for the card.
 */

export type ClaudeCredential = {kind: 'setup_token'; token: string} | {kind: 'api_key'; key: string};

const storedTokenSchema = z.object({token: z.string()});
const storedKeySchema = z.object({key: z.string()});

function decrypted(row: ClaudeAccountRow): Result<ClaudeCredential, ApiError> {
	if (row.kind === 'setup_token') {
		return readStoredJson(row.credential, storedTokenSchema).map(({token}) => ({kind: 'setup_token', token}));
	}
	return readStoredJson(row.credential, storedKeySchema).map(({key}) => ({kind: 'api_key', key}));
}

/**
 * The member's Claude credential, ready to use, or null when they connected none. A token past
 * the end the mint reported is refused here rather than by the model, and the account marked so.
 */
export function claudeCredentialFor(userId: string, now = new Date()): Promise<Result<ClaudeCredential | null, ApiError>> {
	return Do(async ($) => {
		const row = $(await getClaudeAccount(userId));
		if (row === null) {
			return null;
		}
		if (row.expiresAt !== null && row.expiresAt.getTime() <= now.getTime()) {
			log.warn('A member’s Claude token has run out', {userId});
			$(await markClaudeAccountFailed(userId, SIGN_IN_EXPIRED));
			return $(Err(ApiErr.unavailable(SIGN_IN_EXPIRED)));
		}
		return $(decrypted(row));
	});
}

/** Notes that the model turned the member's credential down, for the Account page to say so. */
export function markClaudeCredentialRefused(userId: string): Promise<Result<void, ApiError>> {
	log.warn('The model turned a member’s Claude credential down', {userId});
	return markClaudeAccountFailed(userId, SIGN_IN_EXPIRED);
}

/** Keeps what a turn said of the member's plan, for the Account page's card. */
export function recordClaudeUsage(userId: string, usage: ClaudeUsage): Promise<Result<void, ApiError>> {
	return setClaudeAccountUsage(userId, usage);
}
