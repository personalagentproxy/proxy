import type {AuditAction, AuditOutcome} from '@prisma/client';
import type {Result} from 'ts-results-es';

import {type ApiError, wrapDb} from '@proxy/utils';

import {db} from '.';

export type AuditEntryRow = {
	id: string;
	agentId: string;
	connectionId: string;
	collectionId: string;
	action: AuditAction;
	recordTitle: string | null;
	outcome: AuditOutcome;
	createdAt: Date;
};

/** Logs one request of an agent, and marks the agent active now. */
export async function logAgentRequest(data: {
	orgId: string;
	agentId: string;
	connectionId: string;
	collectionId: string;
	action: AuditAction;
	recordTitle: string | null;
	outcome: AuditOutcome;
}): Promise<Result<void, ApiError>> {
	return wrapDb(async () => {
		await db.$transaction([
			db.auditEntry.create({data}),
			db.agent.update({where: {id: data.agentId}, data: {lastActiveAt: new Date()}}),
		]);
	});
}

/** Newest first, optionally only one agent's or one connection's requests. */
export async function listAuditEntries(
	orgId: string,
	filter: {agentId?: string; connectionId?: string},
	take: number,
): Promise<Result<AuditEntryRow[], ApiError>> {
	return wrapDb(() =>
		db.auditEntry.findMany({
			where: {orgId, ...filter},
			orderBy: {createdAt: 'desc'},
			take,
			select: {
				id: true,
				agentId: true,
				connectionId: true,
				collectionId: true,
				action: true,
				recordTitle: true,
				outcome: true,
				createdAt: true,
			},
		}),
	);
}
