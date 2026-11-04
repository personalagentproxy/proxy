import {type Mock, mock} from 'bun:test';

import type {PollStore} from './store';

/** The store as polling's tests give it: every method a mock, typed as the store's, answering what the test says. */
export type FakePollStore = {[K in keyof PollStore]: Mock<PollStore[K]>};

export function fakePollStore(): FakePollStore {
	return {
		claimPoll: mock<PollStore['claimPoll']>(),
		renewPollLease: mock<PollStore['renewPollLease']>(),
		finishPoll: mock<PollStore['finishPoll']>(),
		deletePoll: mock<PollStore['deletePoll']>(),
		getPollConnection: mock<PollStore['getPollConnection']>(),
		logPoll: mock<PollStore['logPoll']>(),
	};
}
