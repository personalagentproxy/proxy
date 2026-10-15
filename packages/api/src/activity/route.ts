import type {Result} from 'ts-results-es';
import {z} from 'zod';

import {type ApiError, Do, parseSchema} from '@proxy/utils';
import {listAuditEntries} from '@proxy/db/audit';

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

const querySchema = z.object({agentId: z.string().min(1).optional(), connectionId: z.string().min(1).optional()});

/** The organization's agent requests, newest first, the latest 500. */
export function handleListActivityRoute(request: AuthenticatedRequest): Promise<Result<{entries: AuditEntryResponse[]}, ApiError>> {
	return Do(async ($) => {
		const {agentId, connectionId} = $(parseSchema(querySchema, request.query));
		const orgId = $(await requireUserOrgId(request));
		const filter = {...(agentId === undefined ? {} : {agentId: agentId === PROXY ? null : agentId}), ...(connectionId === undefined ? {} : {connectionId})};
		const rows = $(await listAuditEntries(orgId, filter, MAX_ENTRIES));
		return {entries: rows.map(({createdAt, ...entry}) => ({...entry, at: createdAt.toISOString()}))};
	});
}
