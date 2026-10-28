import {describe, expect, test} from 'bun:test';
import type {InspectedEntry, InspectedJob, InspectedThread} from '@/client/inspect-client';
import {
	coveredSeq,
	formatDue,
	formatDuration,
	jobTitle,
	lastAttempt,
	threadStatus,
	tokensOf,
} from './inspect';

const now = '2026-10-21T10:00:00.000Z';

function job(extra: Partial<InspectedJob>): InspectedJob {
	return {
		id: 'job-1',
		threadId: 'thread-1',
		kind: 'inference',
		status: 'queued',
		entryId: null,
		callId: null,
		runAt: now,
		claimedBy: null,
		leaseExpiresAt: null,
		attempts: 0,
		error: null,
		createdAt: now,
		...extra,
	};
}

function entry(extra: Partial<InspectedEntry>): InspectedEntry {
	return {
		id: 'e1',
		seq: 1,
		kind: 'person',
		text: '',
		toolCalls: null,
		callId: null,
		isError: false,
		pending: false,
		inputTokens: null,
		outputTokens: null,
		coversSeq: null,
		hasSystem: false,
		jobId: null,
		at: now,
		...extra,
	};
}

function thread(extra: Partial<InspectedThread>): InspectedThread {
	return {
		id: 'thread-1',
		parentThreadId: null,
		parentCallId: null,
		title: null,
		taskId: null,
		finishedAt: null,
		createdAt: now,
		entries: [],
		jobs: [],
		events: [],
		state: {
			ready: false,
			pendingCalls: [],
			turnsAlone: 0,
			maxTurnsAlone: 30,
			lastInputTokens: 0,
			compactAtTokens: 80_000,
			compactionCoversSeq: null,
		},
		...extra,
	};
}

describe('threadStatus', () => {
	test('is at work while a job runs, and queued while one is due', () => {
		expect(threadStatus(thread({jobs: [job({status: 'running'})]}), now).kind).toBe('working');
		expect(threadStatus(thread({jobs: [job({status: 'queued'})]}), now).kind).toBe('queued');
	});

	test('is asleep until the first of its jobs due later, and only when every open job is', () => {
		const later = job({id: 'j2', kind: 'tool', runAt: '2026-10-21T10:05:00.000Z'});
		const sooner = job({id: 'j3', kind: 'tool', runAt: '2026-10-21T10:01:00.000Z'});
		expect(threadStatus(thread({jobs: [later, sooner]}), now)).toEqual({
			kind: 'asleep',
			until: '2026-10-21T10:01:00.000Z',
		});
		expect(threadStatus(thread({jobs: [later, job({status: 'queued'})]}), now).kind).toBe('queued');
	});

	test('waits for the person with nothing open, and a finished sub-agent reported, or failed where a job did', () => {
		expect(threadStatus(thread({jobs: [job({status: 'done'})]}), now).kind).toBe('waiting');
		expect(threadStatus(thread({finishedAt: now, jobs: [job({status: 'done'})]}), now).kind).toBe(
			'reported',
		);
		expect(threadStatus(thread({finishedAt: now, jobs: [job({status: 'failed'})]}), now).kind).toBe(
			'failed',
		);
	});
});

describe('jobTitle', () => {
	test('names a tool job by its call, found in the entry it is in', () => {
		const entries = [
			entry({id: 'e2', kind: 'assistant', toolCalls: [{id: 'c1', name: 'read', arguments: '{}'}]}),
		];
		expect(jobTitle(job({kind: 'tool', entryId: 'e2', callId: 'c1'}), entries)).toBe('read');
		expect(jobTitle(job({kind: 'tool', entryId: 'e9', callId: 'c1'}), entries)).toBe('tool');
		expect(jobTitle(job({}), entries)).toBe('inference');
	});
});

describe('the log’s sums', () => {
	test('add up what the answers cost, and say how far the latest summary reaches', () => {
		const entries = [
			entry({id: 'e1', kind: 'assistant', inputTokens: 100, outputTokens: 10}),
			entry({id: 'e2', seq: 2, kind: 'summary', coversSeq: 1, inputTokens: 50, outputTokens: 5}),
			entry({id: 'e3', seq: 3, kind: 'assistant', inputTokens: 20, outputTokens: 2}),
		];
		expect(tokensOf(entries)).toEqual({input: 170, output: 17});
		expect(coveredSeq(entries)).toBe(1);
		expect(coveredSeq([])).toBe(-1);
	});
});

describe('the times', () => {
	test('are formatted to what matters at their size', () => {
		expect(formatDuration(340)).toBe('340ms');
		expect(formatDuration(1234)).toBe('1.2s');
		expect(formatDuration(130_000)).toBe('2m 10s');
		expect(formatDue('2026-10-21T10:00:12.000Z', now)).toBe('in 12.0s');
		expect(formatDue('2026-10-21T09:00:00.000Z', now)).toBe('due');
	});

	test('give a job’s last attempt from its events: the claim, and how long it ran once it ended', () => {
		const events = [
			{
				id: 'ev1',
				jobId: 'job-1',
				threadId: 'thread-1',
				kind: 'claimed' as const,
				workerId: 'w1',
				error: null,
				at: '2026-10-21T10:00:00.000Z',
			},
			{
				id: 'ev2',
				jobId: 'job-1',
				threadId: 'thread-1',
				kind: 'requeued' as const,
				workerId: 'w1',
				error: 'down',
				at: '2026-10-21T10:00:01.000Z',
			},
			{
				id: 'ev3',
				jobId: 'job-1',
				threadId: 'thread-1',
				kind: 'claimed' as const,
				workerId: 'w2',
				error: null,
				at: '2026-10-21T10:00:06.000Z',
			},
		];
		expect(lastAttempt(job({}), events)).toEqual({
			claimedAt: '2026-10-21T10:00:06.000Z',
			ranMs: null,
		});
		const done = {
			id: 'ev4',
			jobId: 'job-1',
			threadId: 'thread-1',
			kind: 'done' as const,
			workerId: 'w2',
			error: null,
			at: '2026-10-21T10:00:08.500Z',
		};
		expect(lastAttempt(job({}), [...events, done])).toEqual({
			claimedAt: '2026-10-21T10:00:06.000Z',
			ranMs: 2500,
		});
		expect(lastAttempt(job({}), [])).toEqual({claimedAt: null, ranMs: null});
	});
});
