import type {Prisma} from '@prisma/client';
import type {Result} from 'ts-results-es';

import {type ApiError, wrapDb} from '@proxy/utils';

import {db} from '.';

/**
 * A member's own Claude account (ClaudeAccount): the credential the built-in agent runs under for
 * them, encrypted by the api, one per person: a long-lived token minted on their machine or pasted
 * from `claude setup-token`, or an API key. Only the upsert writes the credential, and the rows
 * handed out carry it as stored, encrypted: what it holds is the api's to read. Beside it, whether
 * the credential was refused, and what the model's provider said of the member's plan as the last
 * turn ran.
 */

export type ClaudeAccountKind = 'setup_token' | 'api_key';

/** How much of one of the plan's windows was used, and when it resets, as the provider said. */
export type ClaudeUsageWindow = {utilization: number; resetsAt: Date | null};

export type ClaudeAccountRow = {
	id: string;
	userId: string;
	kind: ClaudeAccountKind;
	// The credential as stored, encrypted.
	credential: string;
	// When the token ends, as the mint reported it; null for a pasted token whose end isn't known,
	// and for a key.
	expiresAt: Date | null;
	// When the credential was refused or found to have run out, and the words for it, until the
	// person connects again.
	failedAt: Date | null;
	failure: string | null;
	usageFiveHourUtilization: number | null;
	usageFiveHourResetsAt: Date | null;
	usageSevenDayUtilization: number | null;
	usageSevenDayResetsAt: Date | null;
	// When the usage was last read, from a turn's rate-limit headers; null before any.
	usageReadAt: Date | null;
	createdAt: Date;
	updatedAt: Date;
};

const accountSelect = {
	id: true,
	userId: true,
	kind: true,
	credential: true,
	expiresAt: true,
	failedAt: true,
	failure: true,
	usageFiveHourUtilization: true,
	usageFiveHourResetsAt: true,
	usageSevenDayUtilization: true,
	usageSevenDayResetsAt: true,
	usageReadAt: true,
	createdAt: true,
	updatedAt: true,
} as const satisfies Prisma.ClaudeAccountSelect;

/** The member's Claude account, or null when they connected none. */
export function getClaudeAccount(
	userId: string,
): Promise<Result<ClaudeAccountRow | null, ApiError>> {
	return wrapDb(() => db.claudeAccount.findUnique({where: {userId}, select: accountSelect}));
}

/** What connecting stores: the kind, the encrypted credential, and when the token ends where that is known. */
export type NewClaudeAccount = {
	kind: ClaudeAccountKind;
	credential: string;
	expiresAt?: Date | null;
};

/**
 * Connects the member's Claude account, in place of the one they had: a connection again clears
 * the failure, and the usage read on the other credential, since this one may be another plan's.
 */
export function upsertClaudeAccount(
	userId: string,
	account: NewClaudeAccount,
): Promise<Result<ClaudeAccountRow, ApiError>> {
	const values = {
		kind: account.kind,
		credential: account.credential,
		expiresAt: account.expiresAt ?? null,
		failedAt: null,
		failure: null,
		usageFiveHourUtilization: null,
		usageFiveHourResetsAt: null,
		usageSevenDayUtilization: null,
		usageSevenDayResetsAt: null,
		usageReadAt: null,
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

/** Notes that the member's credential was refused or ran out, for the Account page to say so. */
export function markClaudeAccountFailed(
	userId: string,
	failure: string,
): Promise<Result<void, ApiError>> {
	return wrapDb(async () => {
		await db.claudeAccount.updateMany({where: {userId}, data: {failedAt: new Date(), failure}});
	});
}

/** What a turn said of the member's plan: either window, where the provider spoke of it, and when it was read. */
export type ClaudeUsage = {
	fiveHour?: ClaudeUsageWindow;
	sevenDay?: ClaudeUsageWindow;
	readAt: Date;
};

/**
 * Keeps what the last turn said of the member's plan. A window the turn said nothing of keeps
 * what was known of it; `readAt` is the turn's. Nothing to do when the member has no account.
 */
export function setClaudeAccountUsage(
	userId: string,
	usage: ClaudeUsage,
): Promise<Result<void, ApiError>> {
	const fiveHour = usage.fiveHour
		? {
				usageFiveHourUtilization: usage.fiveHour.utilization,
				usageFiveHourResetsAt: usage.fiveHour.resetsAt,
			}
		: {};
	const sevenDay = usage.sevenDay
		? {
				usageSevenDayUtilization: usage.sevenDay.utilization,
				usageSevenDayResetsAt: usage.sevenDay.resetsAt,
			}
		: {};
	return wrapDb(async () => {
		await db.claudeAccount.updateMany({
			where: {userId},
			data: {...fiveHour, ...sevenDay, usageReadAt: usage.readAt},
		});
	});
}
