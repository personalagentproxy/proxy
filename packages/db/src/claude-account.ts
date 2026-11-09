import type {Prisma} from '@prisma/client';
import {Err, Ok, type Result} from 'ts-results-es';

import {type ApiError, wrapDb} from '@proxy/utils';

import {db} from '.';

/**
 * A member's own Claude account (ClaudeAccount): the credential the built-in agent runs under for
 * them, encrypted by the api, one per person. Only `updateClaudeAccountLocked` and the upsert
 * write the credential, and the rows handed out carry it as stored, encrypted: what it holds is
 * the api's to read.
 */

export type ClaudeAccountKind = 'oauth' | 'setup_token' | 'api_key';

export type ClaudeAccountRow = {
	id: string;
	userId: string;
	kind: ClaudeAccountKind;
	// The credential as stored, encrypted.
	credential: string;
	email: string | null;
	subscriptionType: string | null;
	// When a sign-in's access token runs out; null for the other kinds.
	expiresAt: Date | null;
	lastRefreshedAt: Date | null;
	// When a refresh was refused, and the words for it, until the person connects again.
	failedAt: Date | null;
	failure: string | null;
	createdAt: Date;
	updatedAt: Date;
};

const accountSelect = {
	id: true,
	userId: true,
	kind: true,
	credential: true,
	email: true,
	subscriptionType: true,
	expiresAt: true,
	lastRefreshedAt: true,
	failedAt: true,
	failure: true,
	createdAt: true,
	updatedAt: true,
} as const satisfies Prisma.ClaudeAccountSelect;

/** The member's Claude account, or null when they connected none. */
export function getClaudeAccount(
	userId: string,
): Promise<Result<ClaudeAccountRow | null, ApiError>> {
	return wrapDb(() => db.claudeAccount.findUnique({where: {userId}, select: accountSelect}));
}

/** What connecting stores: the kind, the encrypted credential, and what is known of the account. */
export type NewClaudeAccount = {
	kind: ClaudeAccountKind;
	credential: string;
	email?: string | null;
	subscriptionType?: string | null;
	expiresAt?: Date | null;
};

/**
 * Connects the member's Claude account, in place of the one they had: a connection again clears
 * the failure, and what was known of the other account, since this one may be another.
 */
export function upsertClaudeAccount(
	userId: string,
	account: NewClaudeAccount,
): Promise<Result<ClaudeAccountRow, ApiError>> {
	const values = {
		kind: account.kind,
		credential: account.credential,
		email: account.email ?? null,
		subscriptionType: account.subscriptionType ?? null,
		expiresAt: account.expiresAt ?? null,
		lastRefreshedAt: null,
		failedAt: null,
		failure: null,
	};
	return wrapDb(() =>
		db.claudeAccount.upsert({
			where: {userId},
			create: {userId, ...values},
			update: values,
			select: accountSelect,
		}),
	);
}

/** Disconnects the member's Claude account; nothing to do when they had none. */
export function deleteClaudeAccount(userId: string): Promise<Result<void, ApiError>> {
	return wrapDb(async () => {
		await db.claudeAccount.deleteMany({where: {userId}});
	});
}

/**
 * What a locked update writes: a refreshed credential with its new expiry, or that the refresh
 * was refused; `null` leaves the row as it is.
 */
export type ClaudeAccountUpdate =
	| {credential: string; expiresAt: Date | null; lastRefreshedAt: Date}
	| {failedAt: Date; failure: string}
	| null;

/**
 * Reads the member's Claude account with its row locked, so `fn` is the only one reading or
 * refreshing its credential until it answers, across every worker and api instance, and writes
 * what `fn` returns: this is what keeps two refreshes of one refresh token apart. `fn`'s own
 * answer comes back with it; `Ok(null)` when the member has no account. `fn` must not use the
 * database itself, whose connection the lock holds.
 */
export function updateClaudeAccountLocked<T>(
	userId: string,
	fn: (row: ClaudeAccountRow) => Promise<{update: ClaudeAccountUpdate; value: T}>,
): Promise<Result<T | null, ApiError>> {
	return wrapDb(() =>
		db.$transaction(
			async (tx) => {
				const locked = await tx.$queryRaw<Array<{id: string}>>`
					SELECT "id" FROM "ClaudeAccount" WHERE "userId" = ${userId} FOR UPDATE`;
				if (locked.length === 0) {
					return null;
				}
				const row = await tx.claudeAccount.findUnique({where: {userId}, select: accountSelect});
				if (!row) {
					return null;
				}
				const {update, value} = await fn(row);
				if (update === null) {
					return value;
				}
				await tx.claudeAccount.update({where: {userId}, data: update});
				return value;
			},
			{timeout: 30_000},
		),
	);
}

/** Notes that the member's sign-in was refused, for the Account page to say so. */
export function markClaudeAccountFailed(
	userId: string,
	failure: string,
): Promise<Result<void, ApiError>> {
	return wrapDb(async () => {
		await db.claudeAccount.updateMany({where: {userId}, data: {failedAt: new Date(), failure}});
	});
}

/** Keeps what Claude said of the account, once it has been asked. `Ok(false)` when the member has no account. */
export async function setClaudeAccountProfile(
	userId: string,
	profile: {email: string | null; subscriptionType: string | null},
): Promise<Result<boolean, ApiError>> {
	const updated = await wrapDb(() => db.claudeAccount.updateMany({where: {userId}, data: profile}));
	if (updated.isErr()) {
		return Err(updated.error);
	}
	return Ok(updated.value.count > 0);
}
