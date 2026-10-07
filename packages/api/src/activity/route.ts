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
	agentId: string;
	connectionId: string;
	collectionId: string;
	// list, view, create, update or delete, or a command of the collection, such as `send`.
	action: string;
	recordTitle: string | null;
	query: string | null;
	outcome: 'allowed' | 'denied';
};

const querySchema = z.object({agentId: z.string().min(1).optional(), connectionId: z.string().min(1).optional()});

/** The organization's agent requests, newest first, the latest 500. */
export function handleListActivityRoute(request: AuthenticatedRequest): Promise<Result<{entries: AuditEntryResponse[]}, ApiError>> {
	return Do(async ($) => {
		const filter = $(parseSchema(querySchema, request.query));
		const orgId = $(await requireUserOrgId(request));
		const rows = $(await listAuditEntries(orgId, filter, MAX_ENTRIES));
		return {entries: rows.map(({createdAt, ...entry}) => ({...entry, at: createdAt.toISOString()}))};
	});
}
