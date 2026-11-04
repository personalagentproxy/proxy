import * as harness from '@proxy/db/harness';
import * as inspect from '@proxy/db/inspect';

import type {HarnessStore} from '../harness/store';
import {harnessStore} from '../harness/store';

/**
 * What the inspector reads: the harness's own reads it shares (../harness/store), and its own,
 * every job of a conversation and a thread's log whole (@proxy/db/inspect). The harness knows
 * nothing of it: the inspector reads the harness, never the other way.
 */
export type InspectStore = Pick<HarnessStore, 'getPersona' | 'getMemberThread' | 'ensureMemberThread' | 'listSubAgents' | 'getEntry' | 'getJobThread' | 'listEntries'> & {
	listJobEvents: typeof harness.listJobEvents;
	listThreadJobs: typeof inspect.listThreadJobs;
	listEntriesWithPending: typeof inspect.listEntriesWithPending;
};

/** The store in the database. */
export const inspectStore: InspectStore = {
	getPersona: harnessStore.getPersona,
	getMemberThread: harnessStore.getMemberThread,
	ensureMemberThread: harnessStore.ensureMemberThread,
	listSubAgents: harnessStore.listSubAgents,
	getEntry: harnessStore.getEntry,
	getJobThread: harnessStore.getJobThread,
	listEntries: harnessStore.listEntries,
	listJobEvents: harness.listJobEvents,
	listThreadJobs: inspect.listThreadJobs,
	listEntriesWithPending: inspect.listEntriesWithPending,
};
