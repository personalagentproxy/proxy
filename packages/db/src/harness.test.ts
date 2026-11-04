import {afterAll, beforeAll, describe, expect, test} from 'bun:test';
import type {Result} from 'ts-results-es';

import type {ApiError} from '@proxy/utils';
import {readyForInference} from '@proxy/utils/harness';

import {db} from '.';
import {
	appendPersonMessage,
	appendSummary,
	claimJob,
	completeInference,
	completeToolJob,
	createAlert,
	deleteAlert,
	dropConnectionFromWatches,
	endAlert,
	ensureFirstPersona,
	ensureMemberThread,
	failJob,
	finishJob,
	fireAlert,
	getAlert,
	landMatches,
	listEntries,
	listJobEvents,
	listMemberAlerts,
	listOpenJobs,
	listThreadAlerts,
	listWatches,
	requeueJob,
	type ThreadRow,
} from './harness';

// What the harness writes, against the local database: run with it up (`bun run dev`) and the
// environment loaded, `bun --env-file=../../.env test src/harness.test.ts` from this package.
// Without DATABASE_URL, as `bun run test` runs, there is nothing to run against, and this is
// skipped. Everything made here is one organization's, deleted at the end. The agent is woken as
// the api wakes it (@proxy/utils/harness readyForInference).
const databaseUrl = process.env.DATABASE_URL;

function unwrap<T>(result: Result<T, ApiError>): T {
	if (result.isErr()) {
		throw new Error(JSON.stringify(result.error));
	}
	return result.value;
}

describe.skipIf(!databaseUrl)('the harness, against the database', () => {
	const stamp = `${Date.now()}-${process.pid}`;
	let userId = '';
	let orgId = '';
	let agentId = '';
	let thread: ThreadRow;

	beforeAll(async () => {
		const user = await db.user.create({data: {email: `harness-test-${stamp}@example.test`}});
		userId = user.id;
		const org = await db.organization.create({
			data: {name: 'Harness test', slug: `harness-test-${stamp}`, ownerUserId: userId},
		});
		orgId = org.id;
		const agent = await db.agent.create({
			data: {
				orgId,
				providerId: 'built-in',
				name: 'Built in',
				username: `harness-test-${stamp}`,
				passwordHash: '',
			},
		});
		agentId = agent.id;
		const persona = unwrap(await ensureFirstPersona(orgId));
		thread = unwrap(await ensureMemberThread({orgId, agentId, personaId: persona.id, userId}));
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

	test('a claim is noted, and so is the finish: the answer carries its prompt and its job, a delegation’s placeholder and a summary the job too', async () => {
		unwrap(await appendPersonMessage(thread.id, 'Find my invoices', readyForInference));
		const job = unwrap(await claimJob('worker-a', 60_000));
		if (!job) {
			throw new Error('nothing to claim');
		}
		expect(job).toMatchObject({
			threadId: thread.id,
			kind: 'inference',
			claimedBy: 'worker-a',
			attempts: 1,
		});
		unwrap(
			await appendSummary(
				job.id,
				'worker-a',
				thread.id,
				{text: 'Nothing yet.', inputTokens: 5, outputTokens: 1},
				0,
			),
		);
		unwrap(
			await completeInference(
				job.id,
				'worker-a',
				thread.id,
				{
					text: 'Looking.',
					toolCalls: [
						{id: 'c1', name: 'delegate', arguments: '{"title":"Find","brief":"Search."}'},
					],
					inputTokens: 10,
					outputTokens: 2,
					system: 'You are signed in.',
				},
				{plans: {c1: {runAt: new Date(), placeholder: 'Started the sub-agent “Find”.'}}},
				readyForInference,
			),
		);

		const entries = unwrap(await listEntries(thread.id));
		expect(entries.map((entry) => [entry.kind, entry.jobId, entry.system])).toEqual([
			['person', null, null],
			['summary', job.id, null],
			['assistant', job.id, 'You are signed in.'],
			['tool_result', job.id, null],
		]);
		const events = unwrap(await listJobEvents(thread.id));
		expect(events.map((event) => [event.jobId, event.kind, event.workerId, event.error])).toEqual([
			[job.id, 'claimed', 'worker-a', null],
			[job.id, 'done', 'worker-a', null],
		]);
		const claimed = events[0];
		const done = events[1];
		if (!claimed || !done) {
			throw new Error('two events');
		}
		expect(claimed.at.getTime()).toBeLessThanOrEqual(done.at.getTime());
	});

	test('a tool job’s result carries the job; a requeue says why; a failure says why, and its answer carries the job', async () => {
		const tool = unwrap(await claimJob('worker-b', 60_000));
		if (!tool || tool.kind !== 'tool' || tool.callId !== 'c1') {
			throw new Error(`expected the delegation’s tool job, got ${JSON.stringify(tool)}`);
		}
		unwrap(
			await completeToolJob(
				tool.id,
				'worker-b',
				thread.id,
				{
					callId: 'c1',
					text: 'Three invoices.',
					isError: false,
				},
				readyForInference,
			),
		);
		const next = unwrap(await claimJob('worker-c', 60_000));
		if (!next || next.kind !== 'inference') {
			throw new Error(`expected the next turn, got ${JSON.stringify(next)}`);
		}
		unwrap(
			await requeueJob(
				next.id,
				'worker-c',
				thread.id,
				new Date(),
				'The model could not be reached: down',
				readyForInference,
			),
		);
		const again = unwrap(await claimJob('worker-d', 60_000));
		if (!again || again.id !== next.id) {
			throw new Error(`expected the same turn again, got ${JSON.stringify(again)}`);
		}
		expect(again.attempts).toBe(2);
		unwrap(
			await failJob(
				again.id,
				'worker-d',
				'Given up after 4 attempts',
				() => ({kind: 'reply', text: 'Something went wrong on my side.'}),
				readyForInference,
			),
		);

		const entries = unwrap(await listEntries(thread.id));
		expect(entries.slice(-2).map((entry) => [entry.kind, entry.jobId, entry.isError])).toEqual([
			['tool_result', tool.id, false],
			['assistant', next.id, true],
		]);
		const events = unwrap(await listJobEvents(thread.id));
		expect(
			events.slice(2).map((event) => [event.jobId, event.kind, event.workerId, event.error]),
		).toEqual([
			[tool.id, 'claimed', 'worker-b', null],
			[tool.id, 'done', 'worker-b', null],
			[next.id, 'claimed', 'worker-c', null],
			[next.id, 'requeued', 'worker-c', 'The model could not be reached: down'],
			[next.id, 'claimed', 'worker-d', null],
			[next.id, 'failed', 'worker-d', 'Given up after 4 attempts'],
		]);
	});

	test('a finish with nothing written is a done event too', async () => {
		unwrap(await appendPersonMessage(thread.id, 'Try again', readyForInference));
		const job = unwrap(await claimJob('worker-e', 60_000));
		if (!job) {
			throw new Error('nothing to claim');
		}
		unwrap(await finishJob(job.id, 'worker-e'));
		const events = unwrap(await listJobEvents(thread.id));
		expect(events.slice(-2).map((event) => [event.jobId, event.kind, event.workerId])).toEqual([
			[job.id, 'claimed', 'worker-e'],
			[job.id, 'done', 'worker-e'],
		]);
		expect(unwrap(await listOpenJobs(thread.id))).toEqual([]);
	});

	test('a watch is a rule on some connections; what a look finds to match it is kept once and told in the conversation', async () => {
		const watch = {
			kind: 'watch' as const,
			title: 'Mail from the bank',
			brief: 'Mail from the bank about the loan.',
			collectionId: 'emails',
			connectionIds: ['conn-a', 'conn-b'],
			criteria: [{field: 'from', terms: ['@bank.com']}],
		};
		const alert = unwrap(await createAlert(thread, 'c-alert', watch));
		expect(unwrap(await createAlert(thread, 'c-alert', watch)).id).toBe(alert.id);
		expect(alert).toMatchObject({
			at: null,
			collectionId: 'emails',
			connectionIds: ['conn-a', 'conn-b'],
			criteria: '[{"field":"from","terms":["@bank.com"]}]',
		});
		const other = unwrap(
			await createAlert(thread, 'c-other', {...watch, title: 'Anything', criteria: []}),
		);
		expect(unwrap(await listWatches('conn-a', 'emails')).map((rule) => rule.id)).toEqual([
			alert.id,
			other.id,
		]);
		expect(unwrap(await listWatches('conn-c', 'emails'))).toEqual([]);
		expect(unwrap(await listOpenJobs(thread.id))).toEqual([]);

		const before = unwrap(await listEntries(thread.id)).length;
		const item = {
			recordId: 'm1',
			title: 'Your loan',
			url: 'https://mail.example/m1',
			at: '2026-11-04T10:00:00Z',
			fields: {from: 'dana@bank.com', subject: 'Your loan'},
			summary: 'From dana@bank.com',
		};
		const poll = {connectionId: 'conn-a', collectionId: 'emails'};
		const tell = (matched: {title: string}, items: Array<{title: string}>) =>
			`${matched.title}: ${items.map((one) => one.title).join(', ')}`;
		unwrap(
			await landMatches(
				poll,
				[
					{alert, items: [item]},
					{alert: other, items: [item]},
				],
				tell,
				readyForInference,
			),
		);
		const entries = unwrap(await listEntries(thread.id));
		expect(entries.slice(before).map((entry) => [entry.kind, entry.callId, entry.text])).toEqual([
			['event', null, 'Mail from the bank: Your loan'],
			['event', null, 'Anything: Your loan'],
		]);
		const woken = unwrap(await claimJob('worker-h', 60_000));
		expect(woken).toMatchObject({kind: 'inference', threadId: thread.id});
		if (woken) {
			unwrap(await finishJob(woken.id, 'worker-h'));
		}

		// The same record again lands nothing more; a new one does.
		unwrap(
			await landMatches(
				poll,
				[{alert, items: [item, {...item, recordId: 'm2', title: 'Your rate'}]}],
				tell,
				readyForInference,
			),
		);
		expect(unwrap(await listEntries(thread.id)).at(-1)?.text).toBe('Mail from the bank: Your rate');
		const listed = unwrap(await listMemberAlerts(orgId, userId));
		expect(
			listed.map((one) => [
				one.id,
				one.persona.name,
				one.matchCount,
				one.matches.map((match) => match.recordId),
			]),
		).toEqual([
			[other.id, 'General', 1, ['m1']],
			[alert.id, 'General', 2, ['m2', 'm1']],
		]);
		expect(unwrap(await listThreadAlerts(thread.id)).map((one) => one.id)).toEqual([
			alert.id,
			other.id,
		]);

		// A connection gone: dropped from the watches, and one left with none ends and is told.
		const narrow = unwrap(
			await createAlert(thread, 'c-narrow', {...watch, title: 'Only b', connectionIds: ['conn-b']}),
		);
		unwrap(
			await dropConnectionFromWatches(
				'conn-b',
				'emails',
				(one) => `${one.title} ended`,
				readyForInference,
			),
		);
		expect(unwrap(await getAlert(alert.id))?.connectionIds).toEqual(['conn-a']);
		expect(unwrap(await getAlert(narrow.id))).toMatchObject({
			connectionIds: [],
			endedBy: 'connection_gone',
		});
		expect(unwrap(await listEntries(thread.id)).at(-1)).toMatchObject({
			kind: 'event',
			text: 'Only b ended',
			isError: true,
		});
		expect(unwrap(await listWatches('conn-b', 'emails'))).toEqual([]);

		expect(unwrap(await deleteAlert(orgId, userId, alert.id))).toBe(true);
		expect(unwrap(await deleteAlert(orgId, userId, alert.id))).toBe(false);
		expect(unwrap(await listMemberAlerts(orgId, userId)).map((one) => one.id)).toEqual([
			narrow.id,
			other.id,
		]);
		const lastWoken = unwrap(await claimJob('worker-k', 60_000));
		if (lastWoken) {
			unwrap(await finishJob(lastWoken.id, 'worker-k'));
		}
	});

	test('a timed alert fires into the conversation once, and the agent can end one', async () => {
		const now = new Date();
		const timed = unwrap(
			await createAlert(thread, 'c-timed', {
				kind: 'time',
				title: 'Dentist',
				brief: 'Tell them to leave for the dentist.',
				at: new Date(now.getTime() - 1000),
			}),
		);
		const ended = unwrap(
			await createAlert(thread, 'c-ended', {
				kind: 'time',
				title: 'Later',
				brief: 'Later.',
				at: new Date(now.getTime() + 3_600_000),
			}),
		);
		expect(unwrap(await endAlert(thread.id, ended.id, 'agent', now))).toBe(true);
		expect(unwrap(await endAlert(thread.id, ended.id, 'agent', now))).toBe(false);
		expect(unwrap(await getAlert(ended.id))).toMatchObject({endedBy: 'agent'});
		const due = unwrap(await claimJob('worker-l', 60_000));
		if (!due || due.kind !== 'alert' || due.alertId !== timed.id) {
			throw new Error(`expected the timed alert's job, got ${JSON.stringify(due)}`);
		}
		unwrap(
			await fireAlert(
				due.id,
				'worker-l',
				timed.id,
				'The alert “Dentist” is due.',
				readyForInference,
			),
		);
		expect(unwrap(await listEntries(thread.id)).at(-1)).toMatchObject({
			kind: 'event',
			text: 'The alert “Dentist” is due.',
			isError: false,
		});
		expect(unwrap(await getAlert(timed.id))).toMatchObject({endedBy: 'fired'});
		const woken = unwrap(await claimJob('worker-m', 60_000));
		expect(woken).toMatchObject({kind: 'inference', threadId: thread.id});
		if (woken) {
			unwrap(await finishJob(woken.id, 'worker-m'));
		}
		// The ended alert's job was dropped with it.
		expect(unwrap(await claimJob('worker-n', 60_000))).toBeNull();
	});
});
