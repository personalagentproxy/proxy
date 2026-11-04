import type {Result} from 'ts-results-es';

import type {ApiError} from '@proxy/utils';
import {logProxyAction} from '@proxy/db/audit';
import {type ConnectionRow, getConnectionWithCredentialById} from '@proxy/db/connection';
import * as poll from '@proxy/db/poll';
import type {PollRow} from '@proxy/db/poll';

/**
 * What polling reads and writes: the polls, claimed with a lease and finished with where they left
 * off (@proxy/db/poll), the connection a poll looks at, with its credential, and the log of the
 * look as Personal Agent Proxy's own. Each part of polling takes the store, or the part of it it
 * uses, so its tests give it a fake one.
 */
export type PollStore = {
	claimPoll: (workerId: string, leaseMs: number) => Promise<Result<PollRow | null, ApiError>>;
	renewPollLease: (pollId: string, workerId: string, leaseMs: number) => Promise<Result<boolean, ApiError>>;
	finishPoll: (pollId: string, workerId: string, outcome: {cursor: string | null; nextAt: Date; error: string | null}) => Promise<Result<boolean, ApiError>>;
	deletePoll: (pollId: string) => Promise<Result<void, ApiError>>;
	getPollConnection: (connectionId: string) => Promise<Result<(ConnectionRow & {credential: string | null}) | null, ApiError>>;
	logPoll: (entry: {
		orgId: string;
		connectionId: string;
		collectionId: string;
		action: string;
		recordTitle: string | null;
		ownerUserId: string | null;
		userId: string | null;
	}) => Promise<Result<void, ApiError>>;
};

/** The store in the database. */
export const pollStore: PollStore = {
	claimPoll: poll.claimPoll,
	renewPollLease: poll.renewPollLease,
	finishPoll: poll.finishPoll,
	deletePoll: poll.deletePoll,
	getPollConnection: getConnectionWithCredentialById,
	logPoll: logProxyAction,
};
