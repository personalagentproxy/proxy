import {Err, Ok, type Result} from 'ts-results-es';

import {ApiErr, type ApiError, Do, parseSchema} from '@proxy/utils';
import {type ClaudeAccountRow, deleteClaudeAccount, getClaudeAccount, upsertClaudeAccount} from '@proxy/db/claude-account';
import {type ClaudeAccount, claudeTokenBodySchema} from '@proxy/contracts/me';

import {log} from '../observability/log';
import type {AuthenticatedRequest} from '../server/middleware/require-auth';
import {encryptSecret} from '../utils/secret-crypto';
import {classifyPastedToken} from './claude-token';

/**
 * The Account page's Claude card: the member's own Claude account, which the built-in agent runs
 * under for them. A token is handed in as it is, pasted from `claude setup-token` or minted the
 * same way by the desktop app, which knows when it ends and says so; an API key likewise. The api
 * mints nothing. What comes back to the page is the kind, the expiry, the failure and the plan's
 * usage as the last turn had it, never the credential, which is stored encrypted and read only
 * where the agent runs.
 */

// How far out a token's end may be said to be: a year, as `claude setup-token` mints, with room
// for a clock that is off; anything further is a mistake in what was sent.
const MAX_EXPIRY_DAYS = 400;
const DAY_MS = 24 * 60 * 60 * 1000;

const EXPIRY_PAST = 'The token has run out already.';
const EXPIRY_TOO_FAR = `A token's end can be at most ${MAX_EXPIRY_DAYS} days away.`;

// The card's view of the account: never the credential.
function describe(row: ClaudeAccountRow | null): ClaudeAccount {
	if (!row) {
		return {account: null};
	}
	return {
		account: {
			kind: row.kind,
			expiresAt: row.expiresAt?.toISOString() ?? null,
			failure: row.failure,
			connectedAt: row.createdAt.toISOString(),
			usage: usageOf(row),
		},
	};
}

function usageOf(row: ClaudeAccountRow): NonNullable<ClaudeAccount['account']>['usage'] {
	if (row.usageReadAt === null) {
		return null;
	}
	return {
		fiveHour: row.usageFiveHourUtilization === null ? null : {utilization: row.usageFiveHourUtilization, resetsAt: row.usageFiveHourResetsAt?.toISOString() ?? null},
		sevenDay: row.usageSevenDayUtilization === null ? null : {utilization: row.usageSevenDayUtilization, resetsAt: row.usageSevenDayResetsAt?.toISOString() ?? null},
		readAt: row.usageReadAt.toISOString(),
	};
}

// When the token ends, as sent: a moment still to come, and not further off than a token can be
// minted for; nothing where none was sent.
function expiryOf(sent: string | undefined, now: Date): Result<Date | null, ApiError> {
	if (sent === undefined) {
		return Ok(null);
	}
	const expiresAt = new Date(sent);
	if (expiresAt.getTime() <= now.getTime()) {
		return Err(ApiErr.validationError(EXPIRY_PAST));
	}
	if (expiresAt.getTime() > now.getTime() + MAX_EXPIRY_DAYS * DAY_MS) {
		return Err(ApiErr.validationError(EXPIRY_TOO_FAR));
	}
	return Ok(expiresAt);
}

/** `GET /api/me/claude` — how the member's Claude account is connected, or `null`. */
export function handleGetClaudeAccountRoute(request: AuthenticatedRequest): Promise<Result<ClaudeAccount, ApiError>> {
	return Do(async ($) => describe($(await getClaudeAccount(request.user.userId))));
}

/**
 * `POST /api/me/claude/token` — connects a `claude setup-token` value or an Anthropic API key, as
 * handed in, with when the token ends where the sender knows it; a key has no end to know.
 */
export function handleClaudeTokenRoute(request: AuthenticatedRequest, now = new Date()): Promise<Result<ClaudeAccount, ApiError>> {
	return Do(async ($) => {
		const {token, expiresAt: sent} = $(parseSchema(claudeTokenBodySchema, request.body));
		const kind = $(classifyPastedToken(token));
		const expiresAt = kind === 'setup_token' ? $(expiryOf(sent, now)) : null;
		const stored = kind === 'setup_token' ? {token} : {key: token};
		const encrypted = $(encryptSecret(JSON.stringify(stored)));
		const row = $(await upsertClaudeAccount(request.user.userId, {kind, credential: encrypted, expiresAt}));
		log.info('Connected a Claude account', {userId: request.user.userId, kind, expiresAt: expiresAt?.toISOString() ?? null});
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
