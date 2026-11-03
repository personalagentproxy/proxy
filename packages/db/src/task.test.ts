import {afterAll, beforeAll, describe, expect, test} from 'bun:test';
import type {Result} from 'ts-results-es';

import type {ApiError} from '@proxy/utils';

import {db} from '.';
import {
	type AgentTaskRow,
	createAgentTask,
	finishAgentTask,
	getAgentTask,
	isAgentTaskOpen,
	listAgentTasksBetween,
	touchAgentTask,
} from './task';

// How tasks left open are taken up again, against the local database: run with it up (`bun run
// dev`) and the environment loaded, `bun --env-file=../../.env test src/task.test.ts` from this
// package. Without DATABASE_URL, as `bun run test` runs, there is nothing to run against, and this
// is skipped. Everything made here is one organization's, deleted at the end.
const databaseUrl = process.env.DATABASE_URL;

const HOUR = 60 * 60 * 1000;

function unwrap<T>(result: Result<T, ApiError>): T {
	if (result.isErr()) {
		throw new Error(JSON.stringify(result.error));
	}
	return result.value;
}

describe.skipIf(!databaseUrl)('tasks, against the database', () => {
	const stamp = `${Date.now()}-${process.pid}`;
	let userId = '';
	let orgId = '';
	let agentId = '';

	beforeAll(async () => {
		const user = await db.user.create({data: {email: `task-test-${stamp}@example.test`}});
		userId = user.id;
		const org = await db.organization.create({
			data: {name: 'Task test', slug: `task-test-${stamp}`, ownerUserId: userId},
		});
		orgId = org.id;
		const agent = await db.agent.create({
			data: {
				orgId,
				providerId: 'claude',
				name: 'Claude',
				username: `task-test-${stamp}`,
				passwordHash: '',
			},
		});
		agentId = agent.id;
	});

	afterAll(async () => {
		if (orgId !== '') {
			await db.organization.delete({where: {id: orgId}});
		}
		if (userId !== '') {
			await db.user.delete({where: {id: userId}});
		}
		await db.$disconnect();
	});

	// A task with a sub-task, both started and last worked on an hour ago, so both left open.
	async function leftOpenLine(title: string): Promise<{parentId: string; childId: string}> {
		const base = {
			orgId,
			agentId,
			ownerUserId: null,
			goal: 'Archive the newsletters',
			via: 'mcp' as const,
		};
		const parent = unwrap(await createAgentTask({...base, parentId: null, title}));
		const child = unwrap(
			await createAgentTask({...base, parentId: parent?.id ?? null, title: `${title}, part`}),
		);
		if (!parent || !child) {
			throw new Error('the tasks were not made');
		}
		const anHourAgo = new Date(Date.now() - HOUR);
		await db.agentTask.updateMany({
			where: {id: {in: [parent.id, child.id]}},
			data: {createdAt: anHourAgo, lastActiveAt: anHourAgo},
		});
		return {parentId: parent.id, childId: child.id};
	}

	async function read(taskId: string): Promise<AgentTaskRow> {
		const task = unwrap(await getAgentTask(orgId, agentId, taskId));
		if (!task) {
			throw new Error(`no task ${taskId}`);
		}
		return task;
	}

	test('a call for a sub-task left open takes it up again, and the task above it too', async () => {
		const {parentId, childId} = await leftOpenLine('Triage inbox');
		const before = Date.now();

		expect(unwrap(await touchAgentTask(orgId, agentId, await read(childId)))).toBe(true);

		const parent = unwrap(await getAgentTask(orgId, agentId, parentId));
		const child = unwrap(await getAgentTask(orgId, agentId, childId));
		expect(child?.lastActiveAt.getTime()).toBeGreaterThanOrEqual(before);
		expect(parent?.lastActiveAt.getTime()).toBeGreaterThanOrEqual(before);
	});

	test('a task left open is taken up again to be finished, with what was done', async () => {
		const {parentId} = await leftOpenLine('Plan the week');

		const finished = unwrap(await finishAgentTask(orgId, agentId, parentId, 'Listed the events'));

		expect(finished?.finishedAt).not.toBeNull();
		expect(finished?.outcome).toBe('Listed the events');
	});

	test('a sub-task left open under a task finished without it stays as it was', async () => {
		const {parentId, childId} = await leftOpenLine('Book travel');
		unwrap(await finishAgentTask(orgId, agentId, parentId, 'Booked the train'));
		const before = await read(childId);

		expect(unwrap(await isAgentTaskOpen(orgId, agentId, childId))).toBe(false);
		expect(unwrap(await touchAgentTask(orgId, agentId, before))).toBe(false);
		const finished = unwrap(await finishAgentTask(orgId, agentId, childId, 'Found a hotel'));

		expect(finished?.finishedAt).toBeNull();
		expect(finished?.lastActiveAt).toEqual(before?.lastActiveAt);
	});

	test('a task finished is not taken up again', async () => {
		const {parentId} = await leftOpenLine('Reply to Dana');
		unwrap(await finishAgentTask(orgId, agentId, parentId, null));

		expect(unwrap(await touchAgentTask(orgId, agentId, await read(parentId)))).toBe(false);
	});

	test('a task done for within the last minute is not written again', async () => {
		const {childId} = await leftOpenLine('Sort receipts');
		const aMomentAgo = new Date(Date.now() - 30 * 1000);
		await db.agentTask.update({where: {id: childId}, data: {lastActiveAt: aMomentAgo}});

		expect(unwrap(await touchAgentTask(orgId, agentId, await read(childId)))).toBe(true);
		expect((await read(childId)).lastActiveAt).toEqual(aMomentAgo);
	});

	test('a task left open is read as open without being taken up again', async () => {
		const {parentId, childId} = await leftOpenLine('Draft the agenda');
		const before = await read(childId);

		expect(unwrap(await isAgentTaskOpen(orgId, agentId, childId))).toBe(true);
		expect(unwrap(await isAgentTaskOpen(orgId, agentId, 'no-such-task'))).toBe(false);
		expect((await read(childId)).lastActiveAt).toEqual(before.lastActiveAt);
		expect((await read(parentId)).lastActiveAt).toEqual(before.lastActiveAt);
	});

	test('a stretch of time holds the tasks left open that had something done for them in it, and those under way', async () => {
		const viewer = {orgId, userId};
		const {parentId: before} = await leftOpenLine('Left open before the stretch');
		const {parentId: inside} = await leftOpenLine('Left open in the stretch');
		const {parentId: running} = await leftOpenLine('Still under way');
		const now = Date.now();
		await db.agentTask.update({
			where: {id: before},
			data: {lastActiveAt: new Date(now - 40 * 60 * 1000)},
		});
		await db.agentTask.update({
			where: {id: inside},
			data: {lastActiveAt: new Date(now - 25 * 60 * 1000)},
		});
		await db.agentTask.update({
			where: {id: running},
			data: {lastActiveAt: new Date(now - 5 * 60 * 1000)},
		});

		// The half hour up to ten minutes ago.
		const listed = unwrap(
			await listAgentTasksBetween(
				viewer,
				new Date(now - 30 * 60 * 1000),
				new Date(now - 10 * 60 * 1000),
				200,
			),
		);
		const ids = listed.map((task) => task.id);

		expect(ids).toContain(inside);
		expect(ids).toContain(running);
		expect(ids).not.toContain(before);
	});
});
