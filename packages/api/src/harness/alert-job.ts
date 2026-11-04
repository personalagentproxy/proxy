import {Err, type Result} from 'ts-results-es';

import {ApiErr, type ApiError, Do} from '@proxy/utils';
import type {JobRow} from '@proxy/db/harness';

import {dueText} from './alerts';
import type {HarnessStore} from './store';

/**
 * An alert job: a timed alert that is due. It fires: what the agent noted for it lands in the
 * conversation it was set in, as an event, for the agent to tell the person, and the alert is
 * gone. One cancelled or deleted since the job was due is nothing to do. A watch has no job: the
 * poller finds what it is for (watches.ts).
 */

/** What an alert job needs of the store. */
export type AlertJobStore = Pick<HarnessStore, 'fireAlert' | 'finishJob'>;

/** Runs the job: the alert fired, where it is still set. */
export function runAlertJob(store: AlertJobStore, job: JobRow, workerId: string): Promise<Result<void, ApiError>> {
	return Do(async ($) => {
		if (job.alertId === null) {
			$(await store.finishJob(job.id, workerId));
			return;
		}
		if (!$(await store.fireAlert(job.id, workerId, job.threadId, job.alertId, dueText))) {
			return $(Err(ApiErr.conflict('The job was no longer this worker’s')));
		}
	});
}
