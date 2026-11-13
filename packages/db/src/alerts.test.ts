import {afterAll, beforeAll, describe, expect, test} from 'bun:test';
import type {Result} from 'ts-results-es';

import type {ApiError} from '@proxy/utils';
import {readyForInference} from '@proxy/utils/harness';

import {db} from '.';
import {
	type AlertRow,
	claimDueAlerts,
	claimDuePolls,
	completeSetAlert,
	deleteAlert,
	fireAlert,
	type NewAlert,
	type PollRow,
	recordLook,
	setAlertInline,
} from './alerts';
import {
	claimJob,
	completeInference,
	ensureFirstPersona,
	ensureMemberChat,
	finishJob,
	type JobRow,
	listEntries,
	openThread,
	type ThreadRow,
} from './harness';

// What the alerts write, against the local database: run with it up (`bun run dev`) and the
// environment loaded, `bun --env-file=../../.env test src/alerts.test.ts` from this package.
// Without DATABASE_URL, as `bun run test` runs, there is nothing to run against, and this is
// skipped. Everything made here is one organization's, deleted at the end.
const databaseUrl = process.env.DATABASE_URL;

function unwrap<T>(result: Result<T, ApiError>): T {
	if (result.isErr()) {
		throw new Error(JSON.stringify(result.error));
	}
	return result.value;
}

// The alerts set in a thread, oldest first, as an AlertRow has each.
function alertsIn(threadId: string): Promise<AlertRow[]> {
	return db.agentAlert.findMany({
		where: {threadId},
		omit: {nextAt: true},
		orderBy: {createdAt: 'asc'},
	});
}

const TEN_MINUTES = 10 * 60 * 1000;

describe.skipIf(!databaseUrl)('the alerts, against the database', () => {
	const stamp = `${Date.now()}-${process.pid}`;
	let userId = '';
	let orgId = '';
	let connectionId = '';
	let agentId = '';
	// Two of the member's chats, each with a thread an alert is set in.
	let chat: ThreadRow;
	let otherChat: ThreadRow;
	let thread: ThreadRow;
	let other: ThreadRow;
	let timed: AlertRow;
	let watch: AlertRow;
	let poll: PollRow;

	beforeAll(async () => {
		const user = await db.user.create({data: {email: `alerts-test-${stamp}@example.test`}});
		userId = user.id;
		const org = await db.organization.create({
			data: {name: 'Alerts test', slug: `alerts-test-${stamp}`, ownerUserId: userId},
		});
		orgId = org.id;
		const agent = await db.agent.create({
			data: {
				orgId,
				providerId: 'built-in',
				name: 'Built in',
				username: `alerts-test-${stamp}`,
				passwordHash: '',
			},
		});
		agentId = agent.id;
		const connection = await db.connection.create({
			data: {orgId, integrationId: 'google', account: 'dana@example.com'},
		});
		connectionId = connection.id;
		poll = {connectionId, collectionId: 'emails', cursor: null};
		const persona = unwrap(await ensureFirstPersona(orgId));
		chat = unwrap(
			await ensureMemberChat({orgId, agentId: agent.id, personaId: persona.id, userId}),
		);
		const second = await db.persona.create({
			data: {orgId, name: 'Second', look: JSON.stringify(persona.look), color: persona.color},
		});
		otherChat = unwrap(
			await ensureMemberChat({orgId, agentId: agent.id, personaId: second.id, userId}),
		);
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

	// Opens a thread in the chat with what the member says, which wakes it.
	async function open(of: ThreadRow, text: string): Promise<ThreadRow> {
		const task = {
			orgId,
			agentId,
			ownerUserId: userId,
			personaId: of.personaId,
			parentId: null,
			title: text,
			goal: text,
			via: 'harness' as const,
		};
		const opened = unwrap(await openThread(of.id, text, {title: text, task}, readyForInference));
		if (!opened) {
			throw new Error('no chat');
		}
		return opened.thread;
	}

	// The kinds and texts of the thread's last `count` entries.
	async function lastTexts(of: ThreadRow, count: number): Promise<Array<[string, string]>> {
		return unwrap(await listEntries(of.id))
			.slice(-count)
			.map((entry) => [entry.kind, entry.text]);
	}

	// The tool jobs of a turn of the thread's that made the calls, one each.
	async function toolJobs(callIds: string[]): Promise<JobRow[]> {
		thread = await open(chat, 'Tell me when the bank writes');
		const turn = unwrap(await claimJob('worker-a', 60_000));
		if (!turn) {
			throw new Error('nothing to claim');
		}
		const toolCalls = callIds.map((id) => ({id, name: 'set_alert', arguments: '{}'}));
		const plans = Object.fromEntries(
			callIds.map((id) => [id, {kind: 'job' as const, runAt: new Date()}]),
		);
		unwrap(
			await completeInference(
				turn.id,
				'worker-a',
				thread.id,
				{text: '', toolCalls, inputTokens: 1, outputTokens: 1, system: null},
				{plans},
				readyForInference,
			),
		);
		const jobs: JobRow[] = [];
		for (const _ of callIds) {
			const job = unwrap(await claimJob('worker-b', 60_000));
			if (!job || job.kind !== 'tool') {
				throw new Error(`expected a tool job, got ${JSON.stringify(job)}`);
			}
			jobs.push(job);
		}
		return jobs;
	}

	test('a set_alert call sets its alert as it is answered, a watch with its polls; a worker that lost the job sets none', async () => {
		const [first, second] = await toolJobs(['c1', 'c2']);
		if (!first || !second) {
			throw new Error('two tool jobs');
		}
		const at = new Date(Date.now() + 60 * 60 * 1000);
		const call = (job: JobRow, workerId: string) => ({
			jobId: job.id,
			workerId,
			threadId: thread.id,
			callId: job.callId ?? '',
		});
		const time: NewAlert = {kind: 'time', title: 'Call Dana', brief: 'Remind them.', at};
		const bank: NewAlert = {
			kind: 'watch',
			title: 'Bank',
			brief: 'Tell me.',
			collectionId: 'emails',
			connectionIds: [connectionId],
			terms: ['loan'],
		};

		expect(
			unwrap(
				await completeSetAlert(call(first, 'worker-a'), time, () => 'Set.', readyForInference),
			),
		).toBe(false);
		expect(await alertsIn(thread.id)).toEqual([]);

		const answer = (alert: AlertRow) => `Set ${alert.title}.`;
		expect(
			unwrap(await completeSetAlert(call(first, 'worker-b'), time, answer, readyForInference)),
		).toBe(true);
		expect(
			unwrap(await completeSetAlert(call(second, 'worker-b'), bank, answer, readyForInference)),
		).toBe(true);
		expect(await lastTexts(thread, 2)).toEqual([
			['tool_result', 'Set Call Dana.'],
			['tool_result', 'Set Bank.'],
		]);
		const alerts = await alertsIn(thread.id);
		expect(alerts.map((alert) => [alert.title, alert.at, alert.connectionIds])).toEqual([
			['Call Dana', at, []],
			['Bank', null, [connectionId]],
		]);
		[timed, watch] = alerts as [AlertRow, AlertRow];
		expect(
			await db.connectionPoll.findMany({
				where: {connectionId},
				select: {collectionId: true, cursor: true},
			}),
		).toEqual([{collectionId: 'emails', cursor: null}]);

		// The job run again, its answer written: nothing more is set.
		expect(
			unwrap(await completeSetAlert(call(first, 'worker-b'), time, answer, readyForInference)),
		).toBe(false);
		expect(await alertsIn(thread.id)).toHaveLength(2);
	});

	test('an alert set inline, from the turn’s job, is set alone, nothing written to the log and the job still running; a worker that lost the job sets none', async () => {
		other = await open(otherChat, 'Remind me tomorrow');
		// The next job due that is the other thread's turn; whatever else is due is finished.
		let turn: JobRow | null = null;
		while (turn === null) {
			const claimed = unwrap(await claimJob('worker-c', 60_000));
			if (!claimed) {
				throw new Error('nothing to claim');
			}
			if (claimed.threadId === other.id) {
				turn = claimed;
				continue;
			}
			unwrap(await finishJob(claimed.id, 'worker-c'));
		}
		const at = new Date(Date.now() + 60 * 60 * 1000);
		const time: NewAlert = {kind: 'time', title: 'Tomorrow', brief: 'Remind them.', at};
		const bank: NewAlert = {
			kind: 'watch',
			title: 'Bank again',
			brief: 'Tell me.',
			collectionId: 'emails',
			connectionIds: [connectionId],
			terms: ['loan'],
		};
		const job = (workerId: string) => ({jobId: turn.id, workerId, threadId: other.id});

		expect(unwrap(await setAlertInline(job('worker-z'), time))).toBeNull();
		expect(await alertsIn(other.id)).toEqual([]);

		const made = unwrap(await setAlertInline(job('worker-c'), time));
		const madeWatch = unwrap(await setAlertInline(job('worker-c'), bank));
		expect(made).toMatchObject({threadId: other.id, title: 'Tomorrow', at, connectionIds: []});
		expect(madeWatch).toMatchObject({title: 'Bank again', at: null, connectionIds: [connectionId]});
		expect((await alertsIn(other.id)).map((alert): string | undefined => alert.id)).toEqual([
			made?.id,
			madeWatch?.id,
		]);
		// Nothing landed in the log, and the turn goes on.
		expect(await lastTexts(other, 1)).toEqual([['person', 'Remind me tomorrow']]);
		expect(await db.agentJob.findUnique({where: {id: turn.id}})).toMatchObject({
			status: 'running',
			claimedBy: 'worker-c',
		});

		// Left as they were for the tests that follow: the alerts cancelled, the turn ended.
		unwrap(await deleteAlert(made?.id ?? '', {orgId, userId}));
		unwrap(await deleteAlert(madeWatch?.id ?? '', {orgId, userId}));
		unwrap(
			await completeInference(
				turn.id,
				'worker-c',
				other.id,
				{text: 'Noted.', toolCalls: [], inputTokens: 1, outputTokens: 1, system: null},
				{plans: {}},
				readyForInference,
			),
		);
	});

	test('the timed alerts due are taken once each, at their time, moved on as they are taken', async () => {
		const ids = async () => unwrap(await claimDueAlerts(TEN_MINUTES, 50)).map((alert) => alert.id);
		expect(await ids()).not.toContain(timed.id);
		await db.agentAlert.update({
			where: {id: timed.id},
			data: {nextAt: new Date(Date.now() - 1000)},
		});
		expect(await ids()).toContain(timed.id);
		expect(await ids()).not.toContain(timed.id);
	});

	test('a timed alert lands as it is deleted, once', async () => {
		expect(
			unwrap(await fireAlert(timed, 'The alert “Call Dana” is due now.', readyForInference)),
		).toBe(true);
		expect(await lastTexts(thread, 1)).toEqual([['event', 'The alert “Call Dana” is due now.']]);
		expect(unwrap(await fireAlert(timed, 'Again.', readyForInference))).toBe(false);
		expect(await lastTexts(thread, 1)).toEqual([['event', 'The alert “Call Dana” is due now.']]);
		expect((await alertsIn(thread.id)).map((alert) => alert.id)).toEqual([watch.id]);
	});

	test('a poll a watch is on is taken once, moved on as it is taken', async () => {
		const taken = unwrap(await claimDuePolls(TEN_MINUTES, 50));
		expect(taken).toContainEqual(poll);
		expect(unwrap(await claimDuePolls(TEN_MINUTES, 50))).not.toContainEqual(poll);
	});

	test('a look lands what matched for every watch on the poll as the cursor moves on, once: a look from the same cursor again writes nothing', async () => {
		const elsewhere = await db.agentAlert.create({
			data: {
				orgId,
				userId,
				threadId: other.id,
				title: 'Bank too',
				brief: 'Tell me.',
				collectionId: 'emails',
				connectionIds: [connectionId],
			},
		});
		const second = {...watch, id: elsewhere.id, threadId: other.id, title: 'Bank too'};
		const at = new Date();
		expect(unwrap(await recordLook(poll, 'h1', [], at, readyForInference))).toBe(true);

		const looked = {...poll, cursor: 'h1'};
		const matched = [
			{alert: second, text: 'The alert “Bank too” matched.'},
			{alert: watch, text: 'The alert “Bank” matched.'},
		];
		expect(unwrap(await recordLook(looked, 'h2', matched, at, readyForInference))).toBe(true);
		expect(await lastTexts(thread, 1)).toEqual([['event', 'The alert “Bank” matched.']]);
		expect(await lastTexts(other, 1)).toEqual([['event', 'The alert “Bank too” matched.']]);
		expect(
			(await db.connectionPoll.findMany({where: {connectionId}, select: {cursor: true}}))[0]
				?.cursor,
		).toBe('h2');
		expect((await alertsIn(thread.id))[0]?.lastMatchedAt).toEqual(at);

		expect(
			unwrap(
				await recordLook(looked, 'h3', [{alert: watch, text: 'Again.'}], at, readyForInference),
			),
		).toBe(false);
		expect(await lastTexts(thread, 1)).toEqual([['event', 'The alert “Bank” matched.']]);

		// A watch cancelled since the look began is told nothing; the others still are.
		unwrap(await deleteAlert(elsewhere.id, {orgId, userId}));
		const again = [
			{alert: second, text: 'Gone.'},
			{alert: watch, text: 'The alert “Bank” matched again.'},
		];
		expect(
			unwrap(await recordLook({...poll, cursor: 'h2'}, 'h3', again, at, readyForInference)),
		).toBe(true);
		expect(await lastTexts(other, 1)).toEqual([['event', 'The alert “Bank too” matched.']]);
		expect(await lastTexts(thread, 1)).toEqual([['event', 'The alert “Bank” matched again.']]);
	});

	test('a poll no watch is on has its cursor cleared as it is taken, and is taken no more', async () => {
		expect(unwrap(await deleteAlert(watch.id, {orgId, userId: 'another-user'}))).toBe(false);
		expect(unwrap(await deleteAlert(watch.id, {orgId, userId}))).toBe(true);
		await db.connectionPoll.updateMany({
			where: {connectionId},
			data: {nextAt: new Date(Date.now() - 1000)},
		});
		expect(
			unwrap(await claimDuePolls(TEN_MINUTES, 50)).map((taken) => taken.connectionId),
		).not.toContain(connectionId);
		const idle = await db.connectionPoll.findMany({
			where: {connectionId},
			select: {cursor: true, nextAt: true},
		});
		expect(idle[0]?.cursor).toBeNull();

		await db.connectionPoll.updateMany({
			where: {connectionId},
			data: {nextAt: new Date(Date.now() - 1000)},
		});
		unwrap(await claimDuePolls(TEN_MINUTES, 50));
		const still = await db.connectionPoll.findMany({where: {connectionId}, select: {nextAt: true}});
		expect(still[0]?.nextAt.getTime()).toBeLessThan(Date.now());
	});

	test('a poll goes with its connection', async () => {
		await db.connection.delete({where: {id: connectionId}});
		expect(await db.connectionPoll.count({where: {connectionId}})).toBe(0);
	});
});
