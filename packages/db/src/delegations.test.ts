import {afterAll, beforeAll, describe, expect, test} from 'bun:test';
import type {Result} from 'ts-results-es';
import type {ApiError} from '@proxy/utils';
import {DEFAULT_LOOK, readyForInference} from '@proxy/utils/harness';
import {db} from '.';
import {setAlertInline, listMemberAlerts, deleteAlert} from './alerts';
import {cancelDelegation, delegateToAgent, listDelegations, settleDelegations} from './delegations';
import {
	completeInference,
	createPersona,
	ensureMemberChat,
	getJobThread,
	getThreadAgent,
	listChatThreads,
	openThread,
	type InlineJob,
} from './harness';

function unwrap<T>(r: Result<T, ApiError>): T {
	if (r.isErr()) {
		throw new Error(JSON.stringify(r.error));
	}
	return r.value;
}

describe.skipIf(!process.env.DATABASE_URL)('durable agent delegation', () => {
	const stamp = `${Date.now()}-${process.pid}`;
	let orgId = '';
	let userId = '';
	let otherId = '';
	let agentId = '';
	let headId = '';
	let specialistId = '';
	let teamId = '';
	let otherPersonaId = '';
	beforeAll(async () => {
		userId = (await db.user.create({data: {email: `delegate-${stamp}@example.test`}})).id;
		otherId = (await db.user.create({data: {email: `other-delegate-${stamp}@example.test`}})).id;
		orgId = (
			await db.organization.create({
				data: {name: 'Delegation tests', slug: `delegate-${stamp}`, ownerUserId: userId},
			})
		).id;
		await db.orgMember.createMany({data: [userId, otherId].map((userId) => ({orgId, userId}))});
		agentId = (
			await db.agent.create({
				data: {
					orgId,
					providerId: 'proxy',
					name: 'Built in',
					username: `delegate-${stamp}`,
					passwordHash: '',
				},
			})
		).id;
		const fields = {look: DEFAULT_LOOK, color: 'blue'};
		headId = unwrap(
			await createPersona(orgId, userId, {...fields, name: 'Head', headAgent: true}),
		).id;
		specialistId = unwrap(await createPersona(orgId, userId, {...fields, name: 'Research'})).id;
		teamId = unwrap(
			await createPersona(orgId, userId, {
				...fields,
				name: 'Team research',
				conversationScope: 'team',
			}),
		).id;
		otherPersonaId = unwrap(
			await createPersona(orgId, otherId, {...fields, name: 'Other private'}),
		).id;
	});
	afterAll(async () => {
		await db.organization.deleteMany({where: {id: orgId}});
		await db.user.deleteMany({where: {id: {in: [userId, otherId]}}});
		await db.$disconnect();
	});
	async function claim(threadId: string): Promise<InlineJob> {
		const queued = await db.agentJob.findFirstOrThrow({where: {threadId, status: 'queued'}});
		await db.agentJob.update({
			where: {id: queued.id},
			data: {
				status: 'running',
				claimedBy: 'test-worker',
				leaseExpiresAt: new Date(Date.now() + 60000),
			},
		});
		return {jobId: queued.id, workerId: 'test-worker', threadId};
	}
	async function root(personaId = headId): Promise<InlineJob> {
		const chat = unwrap(await ensureMemberChat({orgId, agentId, personaId, userId}));
		const opened = unwrap(
			await openThread(
				chat.id,
				'Research a synthetic topic',
				{
					title: 'Research',
					task: {
						orgId,
						agentId,
						personaId,
						ownerUserId: userId,
						parentId: null,
						title: 'Research',
						goal: 'Research',
						via: 'harness',
					},
				},
				readyForInference,
			),
		);
		if (!opened) {
			throw new Error('No thread');
		}
		return claim(opened.thread.id);
	}
	async function handoff(job: InlineJob, callKey: string, target = specialistId) {
		const result = unwrap(
			await delegateToAgent(job, callKey, target, 'Compare two fictional options'),
		);
		if (!result || 'error' in result) {
			throw new Error(JSON.stringify(result));
		}
		return result.delegation;
	}
	test('retries return one child; a stale worker cannot create another', async () => {
		const job = await root();
		const first = await handoff(job, 'same-call');
		const second = await handoff(job, 'same-call');
		expect(second.id).toBe(first.id);
		expect(unwrap(await listDelegations(job.threadId))).toHaveLength(1);
		expect(
			unwrap(await delegateToAgent({...job, workerId: 'stale'}, 'new-call', specialistId, 'Task')),
		).toBeNull();
	});
	test('private requests to a team specialist stay outside its shared chat and use shared resources', async () => {
		const job = await root();
		const row = await handoff(job, 'private-to-team', teamId);
		const child = unwrap(await getJobThread(row.childThreadId));
		expect(child?.teamChat).toBe(false);
		expect(child?.userId).toBeNull();
		expect(row.teamAudience).toBe(false);
		expect(row.initiatorUserId).toBe(userId);
		expect((await db.agentTask.findUniqueOrThrow({where: {id: child!.taskId!}})).ownerUserId).toBe(
			userId,
		);
		expect(unwrap(await getThreadAgent(child!))).toMatchObject({
			ownerUserId: null,
			auditOwnerUserId: userId,
		});
		const chat = unwrap(
			await ensureMemberChat({orgId, agentId, personaId: teamId, userId: otherId}),
		);
		expect(unwrap(await listChatThreads(chat.id, [])).map((t) => t.id)).not.toContain(
			row.childThreadId,
		);
	});
	test('private delegated alerts stay scoped to their child and disappear on cancellation', async () => {
		const parent = await root();
		const row = await handoff(parent, 'private-alert', teamId);
		const child = await claim(row.childThreadId);
		const alert = unwrap(
			await setAlertInline(child, {
				kind: 'time',
				title: 'Private check',
				brief: 'Synthetic task',
				at: new Date(Date.now() + 60000),
			}),
		);
		expect(alert?.userId).toBe(userId);
		expect(unwrap(await listMemberAlerts(orgId, otherId)).map((a) => a.id)).not.toContain(
			alert!.id,
		);
		expect(unwrap(await listMemberAlerts(orgId, userId)).map((a) => a.id)).not.toContain(alert!.id);
		expect(
			unwrap(await listMemberAlerts(orgId, userId, child.threadId)).map((a) => a.id),
		).toContain(alert!.id);
		expect(unwrap(await deleteAlert(alert!.id, {orgId, userId: otherId}))).toBe(false);
		unwrap(await cancelDelegation(parent, row.id));
		expect(await db.agentAlert.findUnique({where: {id: alert!.id}})).toBeNull();
	});
	test('team alerts can be seen and cancelled by another member', async () => {
		const parent = await root(teamId);
		const alert = unwrap(
			await setAlertInline(parent, {
				kind: 'time',
				title: 'Team check',
				brief: 'Synthetic task',
				at: new Date(Date.now() + 60000),
			}),
		);
		expect(alert?.userId).toBeNull();
		expect(unwrap(await listMemberAlerts(orgId, otherId)).map((a) => a.id)).toContain(alert!.id);
		expect(unwrap(await deleteAlert(alert!.id, {orgId, userId: otherId}))).toBe(true);
	});
	test('shared conversations refuse private specialists; cycles and other members are refused', async () => {
		const shared = await root(teamId);
		expect(unwrap(await delegateToAgent(shared, 'private', specialistId, 'Task'))).toHaveProperty(
			'error',
		);
		const personal = await root();
		expect(unwrap(await delegateToAgent(personal, 'other', otherPersonaId, 'Task'))).toHaveProperty(
			'error',
		);
		const row = await handoff(personal, 'child');
		const child = await claim(row.childThreadId);
		expect(unwrap(await delegateToAgent(child, 'cycle', headId, 'Task'))).toHaveProperty('error');
	});
	test('completion is persisted and delivered once after a worker restart', async () => {
		const job = await root();
		const row = await handoff(job, 'complete');
		await db.agentJob.update({where: {id: job.jobId}, data: {status: 'done', claimedBy: null}});
		const child = await claim(row.childThreadId);
		expect(
			unwrap(
				await completeInference(
					child.jobId,
					child.workerId,
					child.threadId,
					{
						text: 'Option A meets the stated requirements.',
						toolCalls: [],
						inputTokens: 1,
						outputTokens: 1,
						system: null,
					},
					{end: {outcome: 'Complete'}},
					readyForInference,
				),
			),
		).toBe(true);
		expect((await db.agentDelegation.findUniqueOrThrow({where: {id: row.id}})).status).toBe(
			'completed',
		);
		unwrap(await settleDelegations());
		unwrap(await settleDelegations());
		const events = await db.agentEntry.findMany({where: {threadId: job.threadId, kind: 'event'}});
		expect(events).toHaveLength(1);
		expect(events[0]?.text).toContain('Option A meets the stated requirements.');
		expect(await db.agentJob.count({where: {threadId: job.threadId, status: 'queued'}})).toBe(1);
	});
	test('cancellation fences child jobs and ignores late completions', async () => {
		const job = await root();
		const row = await handoff(job, 'cancel');
		const child = await claim(row.childThreadId);
		expect(unwrap(await cancelDelegation(job, row.id))).toBe(true);
		expect(
			unwrap(
				await completeInference(
					child.jobId,
					child.workerId,
					child.threadId,
					null,
					{end: {outcome: 'Late result'}},
					readyForInference,
				),
			),
		).toBe(false);
		const thread = unwrap(await getJobThread(child.threadId));
		if (!thread) {
			throw new Error('No child');
		}
		expect(unwrap(await getThreadAgent(thread))).toBeNull();
	});

	test('a shared coordinator waits for its specialist and consolidates the delivered result', async () => {
		const coordinator = unwrap(
			await createPersona(orgId, userId, {
				look: DEFAULT_LOOK,
				color: 'blue',
				name: 'Team head',
				conversationScope: 'team',
				headAgent: true,
			}),
		);
		const parent = await root(coordinator.id);
		const row = await handoff(parent, 'shared-complete', teamId);
		expect(row.teamAudience).toBe(true);
		const finish = async (job: InlineJob, text: string) =>
			unwrap(
				await completeInference(
					job.jobId,
					job.workerId,
					job.threadId,
					{text, toolCalls: [], inputTokens: 1, outputTokens: 1, system: null},
					{end: {outcome: text}},
					readyForInference,
				),
			);
		expect(await finish(parent, 'Waiting for research.')).toBe(true);
		const parentThread = unwrap(await getJobThread(parent.threadId))!;
		expect(
			(await db.agentTask.findUniqueOrThrow({where: {id: parentThread.taskId!}})).finishedAt,
		).toBeNull();
		const child = await claim(row.childThreadId);
		expect(
			unwrap(await getThreadAgent(unwrap(await getJobThread(child.threadId))!))?.ownerUserId,
		).toBeNull();
		expect(await finish(child, 'Synthetic research result.')).toBe(true);
		unwrap(await settleDelegations());
		const resumed = await claim(parent.threadId);
		expect(await finish(resumed, 'Consolidated synthetic research.')).toBe(true);
		expect(
			(await db.agentTask.findUniqueOrThrow({where: {id: parentThread.taskId!}})).finishedAt,
		).not.toBeNull();
		const otherChat = unwrap(
			await ensureMemberChat({orgId, agentId, personaId: coordinator.id, userId: otherId}),
		);
		expect(unwrap(await listChatThreads(otherChat.id, [])).map((t) => t.id)).toContain(
			parent.threadId,
		);
	});
	test('nested work respects the depth limit and cancellation closes the entire subtree', async () => {
		const parent = await root();
		const first = await handoff(parent, 'nested-first');
		const firstJob = await claim(first.childThreadId);
		const second = await handoff(firstJob, 'nested-second', teamId);
		const secondJob = await claim(second.childThreadId);
		const thirdPersona = unwrap(
			await createPersona(orgId, userId, {
				look: DEFAULT_LOOK,
				color: 'blue',
				name: 'Third specialist',
				conversationScope: 'team',
			}),
		);
		const third = await handoff(secondJob, 'nested-third', thirdPersona.id);
		const thirdJob = await claim(third.childThreadId);
		const fourthPersona = unwrap(
			await createPersona(orgId, userId, {
				look: DEFAULT_LOOK,
				color: 'blue',
				name: 'Fourth specialist',
				conversationScope: 'team',
			}),
		);
		expect(
			unwrap(await delegateToAgent(thirdJob, 'too-deep', fourthPersona.id, 'Task')),
		).toHaveProperty('error');
		expect(unwrap(await cancelDelegation(parent, first.id))).toBe(true);
		for (const row of [first, second, third]) {
			expect((await db.agentDelegation.findUniqueOrThrow({where: {id: row.id}})).status).toBe(
				'cancelled',
			);
			const thread = unwrap(await getJobThread(row.childThreadId))!;
			expect(
				(await db.agentTask.findUniqueOrThrow({where: {id: thread.taskId!}})).finishedAt,
			).not.toBeNull();
		}
		unwrap(await settleDelegations());
		expect(
			await db.agentJob.count({
				where: {
					threadId: {in: [first.childThreadId, second.childThreadId, third.childThreadId]},
					status: {in: ['queued', 'running']},
				},
			}),
		).toBe(0);
	});
	test('the root budget is bounded and timeouts report failure', async () => {
		const job = await root();
		const rows = [];
		for (let i = 0; i < 8; i++) {
			rows.push(await handoff(job, `call-${i}`));
		}
		expect(unwrap(await delegateToAgent(job, 'ninth', specialistId, 'Task'))).toHaveProperty(
			'error',
		);
		await db.agentDelegation.update({where: {id: rows[0]!.id}, data: {expiresAt: new Date(0)}});
		unwrap(await settleDelegations());
		expect((await db.agentDelegation.findUniqueOrThrow({where: {id: rows[0]!.id}})).status).toBe(
			'failed',
		);
	});
	test('revoked membership prevents execution and withholds a completed result', async () => {
		const job = await root();
		const row = await handoff(job, 'revoked');
		await db.agentDelegation.update({
			where: {id: row.id},
			data: {status: 'completed', result: 'Must not be delivered'},
		});
		await db.orgMember.delete({where: {orgId_userId: {orgId, userId}}});
		unwrap(await settleDelegations());
		const stored = await db.agentDelegation.findUniqueOrThrow({where: {id: row.id}});
		expect(stored.result).toBe('Access changed; result withheld.');
		expect(
			await db.agentEntry.count({
				where: {threadId: job.threadId, text: {contains: 'Must not be delivered'}},
			}),
		).toBe(0);
		await db.orgMember.create({data: {orgId, userId}});
	});
});
