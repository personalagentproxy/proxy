import {type Mock, mock} from 'bun:test';

import type {HarnessStore} from './store';

/** The store as the harness's tests give it: every method a mock, typed as the store's, answering what the test says. */
export type FakeStore = {[K in keyof HarnessStore]: Mock<HarnessStore[K]>};

/** A store for a test, which answers nothing until the test says what each method it calls answers. */
export function fakeStore(): FakeStore {
	return {
		claimJob: mock<HarnessStore['claimJob']>(),
		renewLease: mock<HarnessStore['renewLease']>(),
		finishJob: mock<HarnessStore['finishJob']>(),
		failJob: mock<HarnessStore['failJob']>(),
		requeueJob: mock<HarnessStore['requeueJob']>(),
		getJobThread: mock<HarnessStore['getJobThread']>(),
		getThreadAgent: mock<HarnessStore['getThreadAgent']>(),
		listEntries: mock<HarnessStore['listEntries']>(),
		getEntry: mock<HarnessStore['getEntry']>(),
		appendSummary: mock<HarnessStore['appendSummary']>(),
		completeInference: mock<HarnessStore['completeInference']>(),
		completeToolJob: mock<HarnessStore['completeToolJob']>(),
		startSubAgent: mock<HarnessStore['startSubAgent']>(),
		setThreadTask: mock<HarnessStore['setThreadTask']>(),
		getAgentTask: mock<HarnessStore['getAgentTask']>(),
		createAgentTask: mock<HarnessStore['createAgentTask']>(),
		listPersonas: mock<HarnessStore['listPersonas']>(),
		ensureFirstPersona: mock<HarnessStore['ensureFirstPersona']>(),
		getPersona: mock<HarnessStore['getPersona']>(),
		createPersona: mock<HarnessStore['createPersona']>(),
		updatePersona: mock<HarnessStore['updatePersona']>(),
		deletePersona: mock<HarnessStore['deletePersona']>(),
		getMemberThread: mock<HarnessStore['getMemberThread']>(),
		ensureMemberThread: mock<HarnessStore['ensureMemberThread']>(),
		listShownEntries: mock<HarnessStore['listShownEntries']>(),
		listOpenJobs: mock<HarnessStore['listOpenJobs']>(),
		appendPersonMessage: mock<HarnessStore['appendPersonMessage']>(),
	};
}
