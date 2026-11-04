import {beforeEach, describe, expect, mock, test} from 'bun:test';
import {Ok} from 'ts-results-es';

import type {JobRow} from '@proxy/db/harness';

import {type FakeStore, fakeStore} from './fake-store';

mock.module('../agent-side/tools', () => ({listAgentConnections: mock()}));

const now = new Date('2026-11-04T10:00:00Z');
const job: JobRow = {id: 'job-1', threadId: 'thread-1', kind: 'alert', status: 'running', entryId: null, callId: null, alertId: 'alert-1', runAt: now, claimedBy: 'w1', attempts: 1};

let store: FakeStore;

beforeEach(() => {
	mock.clearAllMocks();
	store = fakeStore();
	store.fireAlert.mockResolvedValue(Ok(true));
	store.finishJob.mockResolvedValue(Ok(true));
});

describe('runAlertJob', () => {
	test('fires the alert in its conversation, with what the agent noted', async () => {
		const {runAlertJob} = await import('./alert-job');
		(await runAlertJob(store, job, 'w1')).unwrap();
		expect(store.fireAlert).toHaveBeenCalledWith('job-1', 'w1', 'thread-1', 'alert-1', expect.any(Function));
		const tell = store.fireAlert.mock.calls[0]?.[4];
		expect(tell?.({title: 'Call Dana', brief: 'Remind them.', at: now})).toBe('The alert “Call Dana” is due now, which you set for 2026-11-04T10:00:00.000Z. What you noted for it: Remind them.');
	});

	test('a job no longer the worker’s is a conflict; one without an alert is finished with nothing written', async () => {
		const {runAlertJob} = await import('./alert-job');
		store.fireAlert.mockResolvedValue(Ok(false));
		expect((await runAlertJob(store, job, 'w1')).unwrapErr().kind).toBe('conflict');
		(await runAlertJob(store, {...job, alertId: null}, 'w1')).unwrap();
		expect(store.finishJob).toHaveBeenCalledWith('job-1', 'w1');
	});
});
