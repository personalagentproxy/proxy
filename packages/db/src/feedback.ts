import type {AuditVia} from '@prisma/client';
import type {Result} from 'ts-results-es';

import {type ApiError, wrapDb} from '@proxy/utils';

import {db} from '.';

/** Keeps what an agent told us, for us to read. */
export async function saveAgentFeedback(data: {
	orgId: string;
	agentId: string;
	providerId: string;
	message: string;
	connectionId: string | null;
	tool: string | null;
	via: AuditVia;
}): Promise<Result<void, ApiError>> {
	return wrapDb(async () => {
		await db.agentFeedback.create({data});
	});
}
