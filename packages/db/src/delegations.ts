import type {AgentDelegation, Prisma} from '@prisma/client';
import {type Result} from 'ts-results-es';
import {type ApiError, wrapDb} from '@proxy/utils';
import {readyForInference} from '@proxy/utils/harness';
import {db} from '.';
import {
	appendEntry,
	lockThread,
	wakeWith,
	writeInline,
	type InlineJob,
	type ThreadRow,
} from './harness';

const MAX_DELEGATIONS = 8;
const MAX_DEPTH = 3;
const LIFETIME_MS = 10 * 60_000;
export type DelegationRow = AgentDelegation;
export type DelegateAnswer = {delegation: DelegationRow} | {error: string};

type Tx = Prisma.TransactionClient;

/** Rechecked before execution and delivery, not only when the handoff is created. */
export async function delegationAllowed(tx: Tx, row: DelegationRow): Promise<boolean> {
	const root = await tx.agentThread.findFirst({
		where: {id: row.rootThreadId, orgId: row.orgId},
		select: {userId: true, teamChat: true},
	});
	if (
		!root ||
		root.teamChat !== row.teamAudience ||
		(!row.teamAudience && root.userId !== row.initiatorUserId)
	) {
		return false;
	}
	if (
		row.initiatorUserId &&
		!(await tx.orgMember.count({where: {orgId: row.orgId, userId: row.initiatorUserId}}))
	) {
		return false;
	}
	const target = await tx.persona.findFirst({
		where: {id: row.targetPersonaId, orgId: row.orgId},
		select: {ownerUserId: true, conversationScope: true},
	});
	if (!target) {
		return false;
	}
	if (row.teamAudience) {
		return target.ownerUserId === null && target.conversationScope === 'team';
	}
	return target.ownerUserId === null || target.ownerUserId === row.initiatorUserId;
}

export function listDelegateAgents(thread: ThreadRow) {
	return wrapDb(async () => {
		const incoming = thread.delegated
			? await db.agentDelegation.findUnique({where: {childThreadId: thread.id}})
			: null;
		if (
			thread.delegated &&
			(!incoming || incoming.status !== 'running' || !(await delegationAllowed(db, incoming)))
		) {
			return [];
		}
		return db.persona.findMany({
			where: {
				orgId: thread.orgId,
				id: {not: thread.personaId},
				...(thread.userId === null
					? {ownerUserId: null, conversationScope: 'team'}
					: {OR: [{ownerUserId: thread.userId}, {ownerUserId: null}]}),
			},
			select: {id: true, name: true, conversationScope: true, headAgent: true},
			orderBy: {name: 'asc'},
		});
	});
}

export function delegateToAgent(
	job: InlineJob,
	callKey: string,
	targetId: string,
	task: string,
): Promise<Result<DelegateAnswer | null, ApiError>> {
	return writeInline(job, null, async (tx, source): Promise<DelegateAnswer> => {
		// Serialize the whole tree's budget without acquiring another thread's lock.
		await tx.$queryRaw`SELECT "id" FROM "Organization" WHERE "id" = ${source.orgId} FOR UPDATE`;
		const existing = await tx.agentDelegation.findUnique({
			where: {sourceThreadId_callKey: {sourceThreadId: source.id, callKey}},
		});
		if (existing) {
			return {delegation: existing};
		}
		const incoming = source.delegated
			? await tx.agentDelegation.findUnique({where: {childThreadId: source.id}})
			: null;
		if (
			source.delegated &&
			(!incoming || incoming.status !== 'running' || !(await delegationAllowed(tx, incoming)))
		) {
			return {error: 'This delegation is no longer authorized or active.'};
		}
		const rootThreadId = incoming?.rootThreadId ?? source.id;
		const initiatorUserId = incoming?.initiatorUserId ?? source.userId;
		const teamAudience = incoming?.teamAudience ?? source.teamChat === true;
		const ancestors = [...(incoming?.ancestors ?? []), source.personaId];
		if (ancestors.includes(targetId) || ancestors.length > MAX_DEPTH) {
			return {error: 'Delegation would create a cycle or exceed the maximum depth of 3.'};
		}
		if ((await tx.agentDelegation.count({where: {rootThreadId}})) >= MAX_DELEGATIONS) {
			return {error: 'This task has reached its budget of 8 delegated tasks.'};
		}
		if (
			initiatorUserId &&
			!(await tx.orgMember.count({where: {orgId: source.orgId, userId: initiatorUserId}}))
		) {
			return {error: 'The initiating member no longer has access.'};
		}
		const target = await tx.persona.findFirst({where: {id: targetId, orgId: source.orgId}});
		if (
			!target ||
			(target.ownerUserId !== null && target.ownerUserId !== source.userId) ||
			(source.userId === null &&
				(target.ownerUserId !== null || target.conversationScope !== 'team'))
		) {
			return {error: 'That specialist is not available to this conversation.'};
		}
		const userId = target.conversationScope === 'team' ? null : source.userId;
		const childTask = await tx.agentTask.create({
			data: {
				orgId: source.orgId,
				agentId: source.agentId,
				ownerUserId: teamAudience ? null : initiatorUserId,
				personaId: target.id,
				parentId: source.taskId,
				title: task.slice(0, 120),
				goal: task,
				via: 'harness',
			},
		});
		const child = await tx.agentThread.create({
			data: {
				orgId: source.orgId,
				agentId: source.agentId,
				personaId: target.id,
				userId,
				parentThreadId: source.id,
				taskId: childTask.id,
				title: task.slice(0, 120),
				delegated: true,
			},
		});
		const row = await tx.agentDelegation.create({
			data: {
				orgId: source.orgId,
				rootThreadId,
				sourceThreadId: source.id,
				childThreadId: child.id,
				targetPersonaId: target.id,
				targetName: target.name,
				initiatorUserId,
				teamAudience,
				ancestors,
				callKey,
				task,
				expiresAt: incoming?.expiresAt ?? new Date(Date.now() + LIFETIME_MS),
			},
		});
		await appendEntry(
			tx,
			{...child, harnessSession: null},
			{
				kind: 'person',
				text: `Delegated task from another agent. Return your result to that agent. You do not have its conversation history.\n\n${task}`,
			},
			readyForInference,
		);
		return {delegation: row};
	});
}

/** Source-thread scoped: IDs from other conversations never disclose their work. */
export function listDelegations(
	sourceThreadId: string,
): Promise<Result<DelegationRow[], ApiError>> {
	return wrapDb(async () => {
		const rows = await db.agentDelegation.findMany({
			where: {sourceThreadId},
			orderBy: {createdAt: 'asc'},
		});
		return Promise.all(
			rows.map(async (row) =>
				(await delegationAllowed(db, row))
					? row
					: {...row, result: 'Access changed; result withheld.'},
			),
		);
	});
}

export function cancelDelegation(
	job: InlineJob,
	id: string,
): Promise<Result<boolean | null, ApiError>> {
	return writeInline(job, null, async (tx, source) => {
		const row = await tx.agentDelegation.findFirst({
			where: {id, sourceThreadId: source.id, status: 'running'},
		});
		if (!row) {
			return false;
		}
		await lockThread(tx, row.childThreadId);
		const current = await tx.agentDelegation.findUnique({where: {id: row.id}});
		if (current?.status !== 'running') {
			return false;
		}
		const ids = new Set([row.childThreadId]);
		let frontier = [row.childThreadId];
		for (let depth = 0; depth < MAX_DEPTH && frontier.length > 0; depth++) {
			// Parents are locked before reading their children, so no new descendant can slip in.
			const children = await tx.agentDelegation.findMany({
				where: {sourceThreadId: {in: frontier}, status: 'running'},
				select: {childThreadId: true},
			});
			frontier = children.map((child) => child.childThreadId);
			for (const childId of frontier) {
				await lockThread(tx, childId);
				ids.add(childId);
			}
		}
		await tx.agentDelegation.updateMany({
			where: {childThreadId: {in: [...ids]}, status: 'running'},
			data: {status: 'cancelled', result: 'Cancelled by the coordinating agent.'},
		});
		await tx.agentAlert.deleteMany({where: {threadId: {in: [...ids]}}});
		const tasks = await tx.agentThread.findMany({
			where: {id: {in: [...ids]}},
			select: {taskId: true},
		});
		await tx.agentTask.updateMany({
			where: {id: {in: tasks.flatMap((t) => (t.taskId ? [t.taskId] : []))}, finishedAt: null},
			data: {finishedAt: new Date(), outcome: 'Delegation cancelled.'},
		});
		await tx.agentJob.updateMany({
			where: {threadId: {in: [...ids]}, status: {in: ['queued', 'running']}},
			data: {status: 'failed', claimedBy: null},
		});
		return true;
	});
}

/** Durable outbox: a worker restart still delivers each completed handoff exactly once. */
export function settleDelegations(): Promise<Result<number, ApiError>> {
	return wrapDb(async () => {
		const expired = await db.agentDelegation.findMany({
			where: {status: 'running', expiresAt: {lte: new Date()}},
			take: 50,
		});
		for (const row of expired) {
			await db.$transaction(async (tx) => {
				const child = await lockThread(tx, row.childThreadId);
				const active = await tx.agentDelegation.findUnique({where: {id: row.id}});
				if (active?.status !== 'running') {
					return;
				}
				if (child?.taskId) {
					await tx.agentTask.updateMany({
						where: {id: child.taskId, finishedAt: null},
						data: {finishedAt: new Date(), outcome: 'Delegation timed out.'},
					});
				}
				await tx.agentAlert.deleteMany({where: {threadId: row.childThreadId}});
				await tx.agentDelegation.updateMany({
					where: {id: row.id, status: 'running'},
					data: {status: 'failed', result: 'Delegation exceeded its ten-minute time budget.'},
				});
				await tx.agentJob.updateMany({
					where: {threadId: row.childThreadId, status: {in: ['queued', 'running']}},
					data: {status: 'failed', claimedBy: null},
				});
			});
		}
		const pending = await db.agentDelegation.findMany({
			where: {status: {not: 'running'}, deliveredAt: null},
			take: 50,
			orderBy: {createdAt: 'asc'},
		});
		let count = 0;
		for (const row of pending) {
			count += await db.$transaction(async (tx) => {
				const source = await lockThread(tx, row.sourceThreadId);
				if (!source) {
					return 0;
				}
				const claimed = await tx.agentDelegation.updateMany({
					where: {id: row.id, deliveredAt: null, status: {not: 'running'}},
					data: {deliveredAt: new Date()},
				});
				if (!claimed.count) {
					return 0;
				}
				const current = await tx.agentDelegation.findUniqueOrThrow({where: {id: row.id}});
				const allowed = await delegationAllowed(tx, current);
				const text = allowed
					? `${current.targetName} — ${current.status}\nDelegation ${current.id}\n\n${current.result ?? 'No result returned.'}`
					: `Delegation ${current.id} could not be delivered because access changed.`;
				if (!allowed) {
					await tx.agentDelegation.update({
						where: {id: current.id},
						data: {status: 'failed', result: 'Access changed; result withheld.'},
					});
				}
				// A cancelled parent must not be woken by a child's late result.
				const parent = source.delegated
					? await tx.agentDelegation.findUnique({where: {childThreadId: source.id}})
					: null;
				if (source.delegated && parent?.status !== 'running') {
					return 1;
				}
				await wakeWith(tx, source, {kind: 'event', text}, readyForInference);
				return 1;
			});
		}
		return count;
	});
}

export function getPersonaCoordination(thread: ThreadRow) {
	return wrapDb(() =>
		db.persona.findFirst({
			where: {id: thread.personaId, orgId: thread.orgId},
			select: {name: true, headAgent: true},
		}),
	);
}
