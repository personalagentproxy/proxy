import type {Result} from 'ts-results-es';
import {z} from 'zod';

import {type ApiError, Do, parseSchema} from '@proxy/utils';
import {addDays, dayIn, isTimeZone} from '@proxy/utils/days';
import {type AuditActionCount, type AuditDayCount, countAuditEntriesByAction, countAuditEntriesByDay, listAuditEntries} from '@proxy/db/audit';

import type {AuthenticatedRequest} from '../server/middleware/require-auth';
import {requireUserOrgId} from '../utils/user-org';

const MAX_ENTRIES = 500;

export type AuditEntryResponse = {
	id: string;
	at: string;
	// None for what Personal Agent Proxy did itself, as the home page's widgets write.
	agentId: string | null;
	connectionId: string;
	collectionId: string;
	// list, view, create, update or delete, or a command of the collection, such as `send`.
	action: string;
	recordTitle: string | null;
	query: string | null;
	outcome: 'allowed' | 'denied';
	// The web app's agent pages, or the MCP server.
	via: 'web' | 'mcp';
};

// `?agentId=proxy` is what Personal Agent Proxy did itself.
const PROXY = 'proxy';

const querySchema = z.object({
	agentId: z.string().min(1).optional(),
	connectionId: z.string().min(1).optional(),
	outcome: z.enum(['allowed', 'denied']).optional(),
	// Only what was made from `from` until before `to`, as a day on the person's clock is.
	from: z.iso.datetime({offset: true}).optional(),
	to: z.iso.datetime({offset: true}).optional(),
});

/** The organization's agent requests, newest first, the latest 500. */
export function handleListActivityRoute(request: AuthenticatedRequest): Promise<Result<{entries: AuditEntryResponse[]}, ApiError>> {
	return Do(async ($) => {
		const {agentId, connectionId, outcome, from, to} = $(parseSchema(querySchema, request.query));
		const orgId = $(await requireUserOrgId(request));
		const filter = {
			...(agentId === undefined ? {} : {agentId: agentId === PROXY ? null : agentId}),
			...(connectionId === undefined ? {} : {connectionId}),
			...(outcome === undefined ? {} : {outcome}),
			...(from === undefined ? {} : {from: new Date(from)}),
			...(to === undefined ? {} : {to: new Date(to)}),
		};
		const rows = $(await listAuditEntries(orgId, filter, MAX_ENTRIES));
		return {entries: rows.map(({createdAt, ...entry}) => ({...entry, at: createdAt.toISOString()}))};
	});
}

// The home page's graph: 53 weeks, so a year of whole weeks ends in this one whatever day it is.
const GRAPH_DAYS = 53 * 7;
// Its summary line: today and the six days before it.
const WEEK_DAYS = 7;

const summaryQuerySchema = z.object({timeZone: z.string().refine(isTimeZone, 'Not a time zone')});

export type ActivitySummaryResponse = {
	// Today on the person's clock, `2026-10-16`, the day the graph ends on.
	today: string;
	// Each agent's requests each day of the graph's, on the person's clock, days without any left
	// out; an `agentId` of null is what Personal Agent Proxy did itself.
	days: AuditDayCount[];
	// The past week's requests by connection, collection, action and outcome, the most first.
	week: AuditActionCount[];
};

/** The organization's activity by day for the home page's graph, and the past week's by action. */
export function handleActivitySummaryRoute(request: AuthenticatedRequest): Promise<Result<ActivitySummaryResponse, ApiError>> {
	return Do(async ($) => {
		const {timeZone} = $(parseSchema(summaryQuerySchema, request.query));
		const orgId = $(await requireUserOrgId(request));
		const today = dayIn(new Date(), timeZone);
		const [days, week] = await Promise.all([countAuditEntriesByDay(orgId, timeZone, addDays(today, 1 - GRAPH_DAYS)), countAuditEntriesByAction(orgId, timeZone, addDays(today, 1 - WEEK_DAYS))]);
		return {today, days: $(days), week: $(week)};
	});
}
