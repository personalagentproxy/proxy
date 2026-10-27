import {Prisma} from '@prisma/client';
import type {Result} from 'ts-results-es';

import {type ApiError, wrapDb} from '@proxy/utils';

import {db} from '.';
import {signedInAgentSelect, type SignedInAgent, toSignedInAgent} from './signed-in-agent';
import {type MemberViewer, visibleTo} from './viewer';

export type AgentRow = {
	id: string;
	orgId: string;
	// The member whose agent it is; null when it is shared with every member.
	ownerUserId: string | null;
	// Who made it, kept once it is shared.
	createdById: string | null;
	providerId: string;
	name: string;
	username: string;
	// A built-in agent's face (@proxy/utils/harness avatars); null for every other agent.
	shape: string | null;
	color: string | null;
	createdAt: Date;
	lastActiveAt: Date | null;
	revokedAt: Date | null;
	grants: Array<{connectionId: string; actionId: string; allowed: boolean}>;
};

// Never the password hash: only signing in reads it.
const agentSelect = {
	id: true,
	orgId: true,
	ownerUserId: true,
	createdById: true,
	providerId: true,
	name: true,
	username: true,
	shape: true,
	color: true,
	createdAt: true,
	lastActiveAt: true,
	revokedAt: true,
	grants: {select: {connectionId: true, actionId: true, allowed: true}},
} as const;

/** The agents the viewer sees, newest first. */
export async function listAgents(viewer: MemberViewer): Promise<Result<AgentRow[], ApiError>> {
	return wrapDb(() =>
		db.agent.findMany({
			where: visibleTo(viewer),
			select: agentSelect,
			orderBy: {createdAt: 'desc'},
		}),
	);
}

/** An agent of the organization by its id, whoever's it is: the agent itself, signed in. `Ok(null)` for none. */
export async function getAgentById(
	orgId: string,
	agentId: string,
): Promise<Result<AgentRow | null, ApiError>> {
	return wrapDb(() => db.agent.findFirst({where: {id: agentId, orgId}, select: agentSelect}));
}

/** `Ok(null)` means no such agent the viewer sees. */
export async function getAgent(
	viewer: MemberViewer,
	agentId: string,
): Promise<Result<AgentRow | null, ApiError>> {
	return wrapDb(() =>
		db.agent.findFirst({where: {id: agentId, ...visibleTo(viewer)}, select: agentSelect}),
	);
}

/**
 * A new agent, `ownerUserId`'s own or, null, shared with every member, made by `createdById`.
 * Fails with a `db_error` that `isUsernameConflict` recognizes when the username is taken.
 */
export async function createAgent(data: {
	orgId: string;
	ownerUserId: string | null;
	createdById: string;
	providerId: string;
	name: string;
	username: string;
	passwordHash: string;
	// A built-in agent's face.
	shape?: string;
	color?: string;
}): Promise<Result<AgentRow, ApiError>> {
	return wrapDb(() => db.agent.create({data, select: agentSelect}));
}

/**
 * Shares a member's agent with every member of its organization, for good: it reaches the shared
 * connections alone from now on, so its settings on the member's own connections go. What it did
 * on the shared connections so far becomes everyone's with it, and so does every task it made no
 * other request for; its requests on any other connection, the member's own or one since
 * disconnected, stay the member's, with the tasks they were made for: what it did in their mailbox
 * is still theirs alone to see.
 */
export async function shareAgent(agentId: string): Promise<Result<void, ApiError>> {
	return wrapDb(async () => {
		await db.$transaction(async (tx) => {
			const agent = await tx.agent.findUnique({
				where: {id: agentId},
				select: {orgId: true, ownerUserId: true},
			});
			if (!agent || agent.ownerUserId === null) {
				return;
			}
			const shared = await tx.connection.findMany({
				where: {orgId: agent.orgId, ownerUserId: null},
				select: {id: true},
			});
			const sharedIds = shared.map((connection) => connection.id);
			const kept = await tx.auditEntry.findMany({
				where: {agentId, connectionId: {notIn: sharedIds}, taskId: {not: null}},
				select: {taskId: true},
				distinct: ['taskId'],
			});
			const keptTaskIds = kept.flatMap((entry) => (entry.taskId === null ? [] : [entry.taskId]));
			await tx.agentGrant.deleteMany({where: {agentId, connectionId: {notIn: sharedIds}}});
			await tx.auditEntry.updateMany({
				where: {agentId, connectionId: {in: sharedIds}},
				data: {ownerUserId: null},
			});
			await tx.agentTask.updateMany({
				where: {agentId, id: {notIn: keptTaskIds}},
				data: {ownerUserId: null},
			});
			await tx.agent.update({where: {id: agentId}, data: {ownerUserId: null}});
		});
	});
}

export function isUsernameConflict(error: ApiError): boolean {
	return isUniqueConflict(error, 'username');
}

function isUniqueConflict(error: ApiError, field: string): boolean {
	if (error.kind !== 'db_error') {
		return false;
	}

	const cause = error.cause;
	if (!(cause instanceof Prisma.PrismaClientKnownRequestError) || cause.code !== 'P2002') {
		return false;
	}

	const target = cause.meta?.target;
	return Array.isArray(target) && target.includes(field);
}

/**
 * `Ok(false)` means no such agent in the organization. A new password or a revocation also signs
 * the agent out everywhere; a revocation signs out its MCP clients too. The caller has checked the
 * agent is theirs to change.
 */
export async function updateAgent(
	orgId: string,
	agentId: string,
	data: {passwordHash?: string; revokedAt?: Date | null},
): Promise<Result<boolean, ApiError>> {
	const signsOut = data.passwordHash !== undefined || Boolean(data.revokedAt);
	return wrapDb(() =>
		db.$transaction(async (tx) => {
			const {count} = await tx.agent.updateMany({where: {id: agentId, orgId}, data});
			if (count > 0 && signsOut) {
				await tx.agentSession.deleteMany({where: {agentId}});
			}
			if (count > 0 && data.revokedAt) {
				await tx.oAuthGrant.deleteMany({where: {agentId}});
				await tx.oAuthCode.deleteMany({where: {agentId}});
			}
			return count > 0;
		}),
	);
}

/** `Ok(false)` means no such agent in the organization. The caller has checked the agent is theirs to change. */
export async function renameAgent(
	orgId: string,
	agentId: string,
	name: string,
): Promise<Result<boolean, ApiError>> {
	return (await wrapDb(() => db.agent.updateMany({where: {id: agentId, orgId}, data: {name}}))).map(
		({count}) => count > 0,
	);
}

/** `Ok(false)` means no such agent in the organization. Its own settings go with it. The caller has checked the agent is theirs to change. */
export async function deleteAgent(
	orgId: string,
	agentId: string,
): Promise<Result<boolean, ApiError>> {
	return (await wrapDb(() => db.agent.deleteMany({where: {id: agentId, orgId}}))).map(
		({count}) => count > 0,
	);
}

/**
 * Sets the agent's own settings for actions of a connection: on, off, or with `null` dropped so the
 * agent follows the connection's default again. Actions left out stay as they are. The caller has
 * checked that the agent and the connection belong to the organization.
 */
export async function setAgentGrants(data: {
	agentId: string;
	connectionId: string;
	actions: Record<string, boolean | null>;
}): Promise<Result<void, ApiError>> {
	const {agentId, connectionId, actions} = data;
	const cleared = Object.keys(actions).filter((actionId) => actions[actionId] === null);
	const set = Object.entries(actions).flatMap(([actionId, allowed]) =>
		allowed === null ? [] : [{actionId, allowed}],
	);
	return wrapDb(async () => {
		await db.$transaction([
			db.agentGrant.deleteMany({
				where: {agentId, connectionId, actionId: {in: cleared}},
			}),
			...set.map(({actionId, allowed}) =>
				db.agentGrant.upsert({
					where: {agentId_connectionId_actionId: {agentId, connectionId, actionId}},
					create: {agentId, connectionId, actionId, allowed},
					update: {allowed},
				}),
			),
		]);
	});
}

/** `Ok(null)` means no agent has the username. Revoked agents are returned; the caller refuses them. */
export async function getAgentForSignIn(
	username: string,
): Promise<Result<{id: string; passwordHash: string; revokedAt: Date | null} | null, ApiError>> {
	return wrapDb(() =>
		db.agent.findUnique({
			where: {username},
			select: {id: true, passwordHash: true, revokedAt: true},
		}),
	);
}

export async function createAgentSession(data: {
	tokenHash: string;
	agentId: string;
	expires: Date;
}): Promise<Result<void, ApiError>> {
	return (await wrapDb(() => db.agentSession.create({data}))).map(() => undefined);
}

export type {SignedInAgent} from './signed-in-agent';

/** `Ok(null)` means no live session: unknown, expired, or the agent has been revoked. */
export async function getSignedInAgent(
	tokenHash: string,
): Promise<Result<SignedInAgent | null, ApiError>> {
	return (
		await wrapDb(() =>
			db.agentSession.findUnique({
				where: {tokenHash},
				select: {expires: true, agent: {select: signedInAgentSelect}},
			}),
		)
	).map((session) => {
		if (!session || session.expires <= new Date()) {
			return null;
		}
		return toSignedInAgent(session.agent);
	});
}

export async function deleteAgentSession(tokenHash: string): Promise<Result<void, ApiError>> {
	return (await wrapDb(() => db.agentSession.deleteMany({where: {tokenHash}}))).map(
		() => undefined,
	);
}
