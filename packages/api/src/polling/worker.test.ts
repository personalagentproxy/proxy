import {beforeEach, describe, expect, mock, test} from 'bun:test';
import {Err, Ok} from 'ts-results-es';

import {ApiErr} from '@proxy/utils';
import type {PollRow} from '@proxy/db/poll';

import {type FakePollStore, fakePollStore} from './fake-store';

const runPoll = mock<
	(store: unknown, consumers: unknown, poll: PollRow, workerId: string) => Promise<ReturnType<typeof Ok<undefined>> | ReturnType<typeof Err<ReturnType<typeof ApiErr.providerUnreachable>>>>
>(async () => Ok(undefined));
mock.module('./run', () => ({runPoll}));

const now = new Date();
const poll: PollRow = {id: 'p1', orgId: 'o1', connectionId: 'c1', collectionId: 'emails', cursor: 'h1', nextAt: now, claimedBy: 'w', lastPolledAt: null, lastError: null};

// Waits for the worker to get through what is due.
const settle = () => new Promise((resolve) => setTimeout(resolve, 50));

let store: FakePollStore;

beforeEach(() => {
	mock.clearAllMocks();
	store = fakePollStore();
	store.renewPollLease.mockResolvedValue(Ok(true));
	store.finishPoll.mockResolvedValue(Ok(true));
});

describe('the poll worker', () => {
	test('claims the polls due one after another and runs each with the consumers, then stops claiming; one that fails is noted for the next look', async () => {
		const {startPollWorker} = await import('./worker');
		const consumers = [{wants: mock(), handle: mock(), connectionGone: mock()}];
		store.claimPoll
			.mockResolvedValueOnce(Ok(poll))
			.mockResolvedValueOnce(Ok({...poll, id: 'p2'}))
			.mockResolvedValue(Ok(null));
		runPoll.mockResolvedValueOnce(Ok(undefined)).mockResolvedValueOnce(Err(ApiErr.providerUnreachable(new Error('down'))));

		const worker = startPollWorker(store, consumers);
		await settle();
		await worker.stop();
		const claims = store.claimPoll.mock.calls.length;
		await settle();

		expect(runPoll).toHaveBeenCalledWith(store, consumers, poll, expect.any(String));
		expect(runPoll).toHaveBeenCalledWith(store, consumers, {...poll, id: 'p2'}, expect.any(String));
		expect(runPoll.mock.calls[0]?.[3]).toBe(runPoll.mock.calls[1]?.[3]);
		expect(store.finishPoll).toHaveBeenCalledTimes(1);
		expect(store.finishPoll).toHaveBeenCalledWith('p2', expect.any(String), {cursor: 'h1', nextAt: expect.any(Date), error: 'down'});
		expect(store.claimPoll.mock.calls.length).toBe(claims);
	});
});
