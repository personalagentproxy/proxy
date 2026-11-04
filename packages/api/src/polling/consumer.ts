import type {Result} from 'ts-results-es';

import type {ApiError} from '@proxy/utils';
import type {PollItem} from '@proxy/utils/alerts';
import type {PollRow} from '@proxy/db/poll';

/**
 * Who wants a connection's collection looked at, and takes what a look finds: the watches of the
 * built-in agent's alerts (harness/watches.ts), and whatever else comes to. A look is handed to
 * every consumer, each in turn, before the poll notes where it left off: so a look is delivered at
 * least once, and a consumer takes the same records twice without harm, as after a worker lost
 * its poll between. A poll nobody wants is deleted; a connection gone is told to each consumer,
 * for what it had on it.
 */
export type PollConsumer = {
	/** Whether the consumer wants the connection's collection looked at. */
	wants: (poll: PollRow) => Promise<Result<boolean, ApiError>>;
	/** What a look found: the records new or changed, the newest first. */
	handle: (poll: PollRow, items: PollItem[]) => Promise<Result<void, ApiError>>;
	/** The connection is gone: whatever the consumer had on it ends. */
	connectionGone: (poll: PollRow) => Promise<Result<void, ApiError>>;
};
