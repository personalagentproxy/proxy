import type {Result} from 'ts-results-es';

import {ApiErr, type ApiError, Do, requirePresent} from '@proxy/utils';
import type {AgentRow} from '@proxy/db/agent';
import {listMemberNames} from '@proxy/db/organization';
import type {AgentLogin} from '@proxy/contracts/agents';

function toAgentLogin(row: AgentRow, createdBy: string | null): AgentLogin {
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
export function respondAll(rows: AgentRow[]): Promise<Result<AgentLogin[], ApiError>> {
	return Do(async ($) => {
		const makers = rows.flatMap((row) => (row.createdById === null ? [] : [{orgId: row.orgId, userId: row.createdById}]));
		const names = $(await listMemberNames(makers));
		return rows.map((row) => {
			const maker = names.find((member) => member.orgId === row.orgId && member.userId === row.createdById);
			return toAgentLogin(row, maker?.name ?? null);
		});
	});
}

export function respond(row: AgentRow): Promise<Result<AgentLogin, ApiError>> {
	return Do(async ($) => {
		const [response] = $(await respondAll([row]));
		return $(requirePresent(response, ApiErr.notFound('agent', row.id)));
	});
}
