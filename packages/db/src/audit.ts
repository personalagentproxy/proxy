import {type AuditOutcome, type AuditVia, Prisma} from '@prisma/client';
import type {Result} from 'ts-results-es';

import {ApiErr, type ApiError, wrapDb} from '@proxy/utils';

import {db} from '.';

export type AuditEntryRow = {
	id: string;
	// None for what Personal Agent Proxy did itself.
	agentId: string | null;
	connectionId: string;
	collectionId: string;
	// list, view, create, update or delete, or a command of the collection, such as `send`.
	action: string;
	recordTitle: string | null;
	query: string | null;
	outcome: AuditOutcome;
	via: AuditVia;
	createdAt: Date;
};

/** Logs one request of an agent, and marks the agent active now. */
export async function logAgentRequest(data: {
	orgId: string;
	agentId: string;
	connectionId: string;
	collectionId: string;
	action: string;
	recordTitle: string | null;
	query: string | null;
	outcome: AuditOutcome;
	via: AuditVia;
}): Promise<Result<void, ApiError>> {
	return wrapDb(async () => {
		await db.$transaction([
			db.auditEntry.create({data}),
			db.agent.update({where: {id: data.agentId}, data: {lastActiveAt: new Date()}}),
		]);
	});
}

/**
 * Logs one thing Personal Agent Proxy did itself for a person, such as making an event from the
 * home page: an entry without an agent, always allowed, since the person asked for it.
 */
export async function logProxyAction(data: {
	orgId: string;
	connectionId: string;
	collectionId: string;
	action: string;
	recordTitle: string | null;
}): Promise<Result<void, ApiError>> {
	return wrapDb(async () => {
		await db.auditEntry.create({data: {...data, agentId: null, query: null, outcome: 'allowed'}});
	});
}

/**
 * Newest first, optionally only one agent's or one connection's requests, only allowed or denied
 * ones, or only those made from `from` until before `to`; an `agentId` of null is what Personal
 * Agent Proxy did itself.
 */
export async function listAuditEntries(
	orgId: string,
	filter: {
		agentId?: string | null;
		connectionId?: string;
		outcome?: AuditOutcome;
		from?: Date;
		to?: Date;
	},
	take: number,
): Promise<Result<AuditEntryRow[], ApiError>> {
	const {from, to, ...rest} = filter;
	const createdAt =
		from === undefined && to === undefined
			? {}
			: {createdAt: {...(from ? {gte: from} : {}), ...(to ? {lt: to} : {})}};
	return wrapDb(() =>
		db.auditEntry.findMany({
			where: {orgId, ...rest, ...createdAt},
			orderBy: {createdAt: 'desc'},
			take,
			select: {
				id: true,
				agentId: true,
				connectionId: true,
				collectionId: true,
				action: true,
				recordTitle: true,
				query: true,
				outcome: true,
				via: true,
				createdAt: true,
			},
		}),
	);
}

// The furthest any time zone's clock is ahead of UTC (Kiribati's): a day there starts 14 hours
// before it does in UTC, so the entries of a day on and after it are all made after this before it.
const MAX_OFFSET_MS = 14 * 60 * 60 * 1000;

function earliestInstantOf(day: string): Date {
	return new Date(Date.parse(`${day}T00:00:00Z`) - MAX_OFFSET_MS);
}

// The database refusing a time zone it has no rules for, `time zone "…" not recognized`: one the
// runtime knows but the database's time zone data, older or newer, doesn't.
export function unknownTimeZoneAs(timeZone: string) {
	return (error: ApiError): ApiError => {
		const cause = error.kind === 'db_error' ? error.cause : null;
		if (
			!(cause instanceof Prisma.PrismaClientKnownRequestError) ||
			cause.code !== 'P2010' ||
			cause.meta?.code !== '22023'
		) {
			return error;
		}
		return ApiErr.validationError(`The database doesn’t know the time zone ${timeZone}`);
	};
}

export type AuditDayCount = {
	// `2026-10-16`, on the time zone's clock.
	day: string;
	agentId: string | null;
	count: number;
	denied: number;
};

/**
 * How many requests each agent made each day from `fromDay` on, and how many of them were denied,
 * the days on the time zone's clock; days without any are left out. An `agentId` of null is what
 * Personal Agent Proxy did itself.
 */
export async function countAuditEntriesByDay(
	orgId: string,
	timeZone: string,
	fromDay: string,
): Promise<Result<AuditDayCount[], ApiError>> {
	// `createdAt` is a UTC time without its zone: read as UTC, then onto the time zone's clock.
	const counted = await wrapDb(
		() =>
			db.$queryRaw<AuditDayCount[]>`
			SELECT to_char(("createdAt" AT TIME ZONE 'UTC') AT TIME ZONE ${timeZone}, 'YYYY-MM-DD') AS day,
				"agentId",
				count(*)::int AS count,
				(count(*) FILTER (WHERE outcome = 'denied'))::int AS denied
			FROM "AuditEntry"
			WHERE "orgId" = ${orgId}
				AND "createdAt" >= ${earliestInstantOf(fromDay)}
				AND (("createdAt" AT TIME ZONE 'UTC') AT TIME ZONE ${timeZone})::date >= ${fromDay}::date
			GROUP BY 1, 2
			ORDER BY 1, 2`,
	);
	return counted.mapErr(unknownTimeZoneAs(timeZone));
}

export type AuditActionCount = {
	connectionId: string;
	collectionId: string;
	action: string;
	outcome: AuditOutcome;
	count: number;
};

/** How many times each action was requested of each collection from `fromDay` on, the time zone's. */
export async function countAuditEntriesByAction(
	orgId: string,
	timeZone: string,
	fromDay: string,
): Promise<Result<AuditActionCount[], ApiError>> {
	const counted = await wrapDb(
		() =>
			db.$queryRaw<AuditActionCount[]>`
			SELECT "connectionId", "collectionId", action, outcome, count(*)::int AS count
			FROM "AuditEntry"
			WHERE "orgId" = ${orgId}
				AND "createdAt" >= ${earliestInstantOf(fromDay)}
				AND (("createdAt" AT TIME ZONE 'UTC') AT TIME ZONE ${timeZone})::date >= ${fromDay}::date
			GROUP BY 1, 2, 3, 4
			ORDER BY count DESC`,
	);
	return counted.mapErr(unknownTimeZoneAs(timeZone));
}
