import {Err, type Result} from 'ts-results-es';

import {ApiErr, type ApiError, Do} from '@proxy/utils';
import type {JobRow} from '@proxy/db/harness';

import {dueText} from './alerts';
import type {HarnessStore} from './store';

/**
 * An alert job: a timed alert that is due. It fires: what the agent noted for it lands in the
 * conversation it was set in, as an event, and the agent tells the person. An alert gone or ended
 * since the job was due, as when the person deleted it, is nothing to do. A watch has no job: the
 * polls of the connections it watches find what it is for (polling, watches.ts).
 */

/** What an alert job needs of the store. */
export type AlertJobStore = Pick<HarnessStore, 'getAlert' | 'finishJob' | 'fireAlert'>;

/** Runs the job: the alert fired; nothing when it is gone or ended. */
export function runAlertJob(store: AlertJobStore, job: JobRow, workerId: string): Promise<Result<void, ApiError>> {
	return Do(async ($) => {
		const alert = job.alertId === null ? null : $(await store.getAlert(job.alertId));
		if (!alert || alert.endedAt !== null || alert.at === null) {
			$(await store.finishJob(job.id, workerId));
			return;
		}
		if (!$(await store.fireAlert(job.id, workerId, alert.id, dueText(alert)))) {
			return $(Err(ApiErr.conflict('The job was no longer this worker’s')));
		}
	});
}
