import type {Result} from 'ts-results-es';

import {ApiErr, type ApiError, Do, requirePresent} from '@proxy/utils';
import type {AgentRow} from '@proxy/db/agent';
import {listMemberNames} from '@proxy/db/organization';

export type AgentResponse = {
	id: string;
	providerId: string;
	name: string;
	username: string;
	// Shared with every member of its organization, rather than one member's own.
	shared: boolean;
	// Who made it, kept once it is shared; null for one from before it was kept.
	createdById: string | null;
	// Their name, or else their address, while they are still in its organization.
	createdBy: string | null;
	createdAt: string;
	lastActiveAt: string | null;
	revokedAt: string | null;
	// One per action where the agent has a setting of its own; every other action follows the
	// connection's default.
	grants: Array<{connectionId: string; actionId: string; allowed: boolean}>;
};

function toAgentResponse(row: AgentRow, createdBy: string | null): AgentResponse {
	return {
		id: row.id,
		providerId: row.providerId,
		name: row.name,
		username: row.username,
		shared: row.ownerUserId === null,
		createdById: row.createdById,
		createdBy,
		createdAt: row.createdAt.toISOString(),
		lastActiveAt: row.lastActiveAt?.toISOString() ?? null,
		revokedAt: row.revokedAt?.toISOString() ?? null,
		grants: row.grants,
	};
}

/** The agents as the web app gets them, with who made each while they are still in its organization. */
export function respondAll(rows: AgentRow[]): Promise<Result<AgentResponse[], ApiError>> {
	return Do(async ($) => {
		const makers = rows.flatMap((row) => (row.createdById === null ? [] : [{orgId: row.orgId, userId: row.createdById}]));
		const names = $(await listMemberNames(makers));
		return rows.map((row) => {
			const maker = names.find((member) => member.orgId === row.orgId && member.userId === row.createdById);
			return toAgentResponse(row, maker?.name ?? null);
		});
	});
}

export function respond(row: AgentRow): Promise<Result<AgentResponse, ApiError>> {
	return Do(async ($) => {
		const [response] = $(await respondAll([row]));
		return $(requirePresent(response, ApiErr.notFound('agent', row.id)));
	});
}
