import {beforeEach, describe, expect, test} from 'bun:test';
import {Ok} from 'ts-results-es';

import type {AlertRow, JobRow} from '@proxy/db/harness';

import {runAlertJob} from './alert-job';
import {type FakeStore, fakeStore} from './fake-store';

const now = new Date('2026-11-03T10:00:00Z');

const timed: AlertRow = {
	id: 'alert-2',
	orgId: 'org-1',
	agentId: 'agent-1',
	personaId: 'persona-1',
	userId: 'user-1',
	threadId: 'thread-1',
	title: 'Dentist',
	brief: 'Leave for the dentist.',
	at: now,
	collectionId: null,
	connectionIds: [],
	criteria: null,
	endedAt: null,
	endedBy: null,
	createdAt: new Date('2026-11-03T09:00:00Z'),
};
const job: JobRow = {id: 'job-1', threadId: 'thread-1', kind: 'alert', status: 'running', entryId: null, callId: null, alertId: 'alert-2', runAt: now, claimedBy: 'w1', attempts: 1};

let store: FakeStore;

beforeEach(() => {
	store = fakeStore();
	store.getAlert.mockResolvedValue(Ok(timed));
	store.finishJob.mockResolvedValue(Ok(true));
	store.fireAlert.mockResolvedValue(Ok(true));
});

describe('runAlertJob', () => {
	test('fires a timed alert with what was noted for it', async () => {
		(await runAlertJob(store, job, 'w1')).unwrap();
		expect(store.fireAlert).toHaveBeenCalledWith('job-1', 'w1', 'alert-2', expect.stringContaining('The alert “Dentist” is due now'));
	});

	test('an alert gone, ended, or not a timed one is nothing to do: the job is finished', async () => {
		store.getAlert.mockResolvedValue(Ok(null));
		(await runAlertJob(store, job, 'w1')).unwrap();
		store.getAlert.mockResolvedValue(Ok({...timed, endedAt: now, endedBy: 'agent'}));
		(await runAlertJob(store, job, 'w1')).unwrap();
		store.getAlert.mockResolvedValue(Ok({...timed, at: null, collectionId: 'emails'}));
		(await runAlertJob(store, job, 'w1')).unwrap();
		(await runAlertJob(store, {...job, alertId: null}, 'w1')).unwrap();
		expect(store.finishJob).toHaveBeenCalledTimes(4);
		expect(store.fireAlert).not.toHaveBeenCalled();
	});

	test('a job no longer the worker’s is a conflict', async () => {
		store.fireAlert.mockResolvedValue(Ok(false));
		expect((await runAlertJob(store, job, 'w1')).unwrapErr()).toMatchObject({kind: 'conflict'});
	});
});
