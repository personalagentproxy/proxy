import type {Result} from 'ts-results-es';

import {type ApiError, wrapDb} from '@proxy/utils';

import {db} from '.';
import {type EntryRow, entrySelect, type JobRow, jobSelect, toEntry} from './harness';

/**
 * What the inspector reads of the built-in agent beyond what the harness does (./harness): every
 * job of a conversation whatever its status, and a thread's log with what is pending. Reads
 * only; the harness alone writes.
 */

/** A job with its whole record: beside what the worker reads, why it failed, its lease and when it was made. */
export type JobDetailRow = JobRow & {
	leaseExpiresAt: Date | null;
	error: string | null;
	createdAt: Date;
};

const jobDetailSelect = {...jobSelect, leaseExpiresAt: true, error: true, createdAt: true} as const;

/** Every job of the threads, whatever its status, oldest first: the queue and its history. */
export async function listThreadJobs(
	threadIds: string[],
): Promise<Result<JobDetailRow[], ApiError>> {
	return wrapDb(() =>
		db.agentJob.findMany({
			where: {threadId: {in: threadIds}},
			select: jobDetailSelect,
			orderBy: {createdAt: 'asc'},
		}),
	);
}

/** The thread's whole log: what the model reads in order, then what is pending, in the order it landed. */
export async function listEntriesWithPending(
	threadId: string,
): Promise<Result<EntryRow[], ApiError>> {
	return (
		await wrapDb(() =>
			db.agentEntry.findMany({
				where: {threadId},
				select: entrySelect,
				orderBy: [{pending: 'asc'}, {seq: 'asc'}],
			}),
		)
	).map((entries) => entries.map(toEntry));
}
