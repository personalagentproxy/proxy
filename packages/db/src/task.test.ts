import {afterAll, beforeAll, describe, expect, test} from 'bun:test';
import type {Result} from 'ts-results-es';

import type {ApiError} from '@proxy/utils';

import {db} from '.';
import {createAgentTask, finishAgentTask, getAgentTask, touchAgentTask} from './task';

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

	// A task with a sub-task, both last worked on an hour ago, so both left open.
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
			data: {lastActiveAt: anHourAgo},
		});
		return {parentId: parent.id, childId: child.id};
	}

	test('a call for a sub-task left open takes it up again, and the task above it too', async () => {
		const {parentId, childId} = await leftOpenLine('Triage inbox');
		const before = Date.now();

		expect(unwrap(await touchAgentTask(orgId, agentId, childId))).toBe(true);

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
		const before = unwrap(await getAgentTask(orgId, agentId, childId));

		expect(unwrap(await touchAgentTask(orgId, agentId, childId))).toBe(false);
		const finished = unwrap(await finishAgentTask(orgId, agentId, childId, 'Found a hotel'));

		expect(finished?.finishedAt).toBeNull();
		expect(finished?.lastActiveAt).toEqual(before?.lastActiveAt);
	});

	test('a task finished is not taken up again', async () => {
		const {parentId} = await leftOpenLine('Reply to Dana');
		unwrap(await finishAgentTask(orgId, agentId, parentId, null));

		expect(unwrap(await touchAgentTask(orgId, agentId, parentId))).toBe(false);
	});
});
