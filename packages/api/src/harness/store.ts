import type {Result} from 'ts-results-es';

import type {ApiError} from '@proxy/utils';
import {readyForInference} from '@proxy/utils/harness';
import {logProxyAction} from '@proxy/db/audit';
import {type ConnectionRow, getConnectionWithCredentialById, listConnectionsByIds} from '@proxy/db/connection';
import * as harness from '@proxy/db/harness';
import type {
	AfterAnswer,
	AlertEnd,
	AlertRow,
	AssistantTurn,
	EntryRow,
	FailureNote,
	JobRow,
	LastMessage,
	ListedAlert,
	NewAlert,
	Persona,
	PersonaRow,
	PollOutcome,
	PollRow,
	SubAgentStart,
	ThreadRow,
} from '@proxy/db/harness';
import {type AgentTaskRow, createAgentTask, getAgentTask, type NewAgentTask} from '@proxy/db/task';
import type {SignedInAgent} from '@proxy/db/agent';

import {matchText} from './alerts';

/**
 * What the harness reads and writes: the job queue, each thread's log and its jobs, the Chat
 * page's personas, the alerts set in conversations and the polls of the connections watched, in
 * the database (@proxy/db/harness). Every write is one transaction, fenced by the worker's lease
 * where it is a job's or a poll's, and takes what it writes as the harness composed it: the rules
 * of the conversation are the harness's own (conversation.ts), as are the words of the alerts
 * (alerts.ts). The agent is woken where what lands leaves its log ready for it
 * (@proxy/utils/harness readyForInference). Each part of the harness takes the store, or the
 * part of it it uses, so its tests give it a fake one.
 */
export type HarnessStore = {
	claimJob: (workerId: string, leaseMs: number) => Promise<Result<JobRow | null, ApiError>>;
	renewLease: (jobId: string, workerId: string, leaseMs: number) => Promise<Result<boolean, ApiError>>;
	finishJob: (jobId: string, workerId: string) => Promise<Result<boolean, ApiError>>;
	failJob: (jobId: string, workerId: string, error: string, noteFor: (job: JobRow, thread: ThreadRow) => FailureNote | null) => Promise<Result<boolean, ApiError>>;
	requeueJob: (jobId: string, workerId: string, threadId: string, runAt: Date, why: string) => Promise<Result<boolean, ApiError>>;

	getJobThread: (threadId: string) => Promise<Result<ThreadRow | null, ApiError>>;
	getThreadAgent: (thread: ThreadRow) => Promise<Result<SignedInAgent | null, ApiError>>;
	listEntries: (threadId: string) => Promise<Result<EntryRow[], ApiError>>;
	getEntry: (entryId: string) => Promise<Result<EntryRow, ApiError>>;
	appendSummary: (jobId: string, workerId: string, threadId: string, summary: {text: string; inputTokens: number; outputTokens: number}, coversSeq: number) => Promise<Result<boolean, ApiError>>;
	completeInference: (jobId: string, workerId: string, threadId: string, turn: AssistantTurn, after: AfterAnswer) => Promise<Result<boolean, ApiError>>;
	completeToolJob: (jobId: string, workerId: string, threadId: string, result: {callId: string; text: string; isError: boolean}) => Promise<Result<boolean, ApiError>>;
	startSubAgent: (jobId: string, workerId: string, parent: ThreadRow, start: SubAgentStart) => Promise<Result<boolean, ApiError>>;
	setThreadTask: (threadId: string, taskId: string) => Promise<Result<void, ApiError>>;
	getAgentTask: (orgId: string, agentId: string, taskId: string) => Promise<Result<AgentTaskRow | null, ApiError>>;
	createAgentTask: (task: NewAgentTask) => Promise<Result<AgentTaskRow | null, ApiError>>;

	listPersonas: (orgId: string, userId: string) => Promise<Result<Array<PersonaRow & {lastMessage: LastMessage | null}>, ApiError>>;
	ensureFirstPersona: (orgId: string) => Promise<Result<PersonaRow, ApiError>>;
	getPersona: (orgId: string, personaId: string) => Promise<Result<PersonaRow | null, ApiError>>;
	createPersona: (orgId: string, createdById: string, persona: Persona) => Promise<Result<PersonaRow, ApiError>>;
	updatePersona: (orgId: string, personaId: string, persona: Persona) => Promise<Result<boolean, ApiError>>;
	deletePersona: (orgId: string, personaId: string) => Promise<Result<boolean, ApiError>>;
	getMemberThread: (personaId: string, userId: string) => Promise<Result<ThreadRow | null, ApiError>>;
	ensureMemberThread: (data: {orgId: string; agentId: string; personaId: string; userId: string}) => Promise<Result<ThreadRow, ApiError>>;
	listShownEntries: (threadId: string) => Promise<Result<EntryRow[], ApiError>>;
	listOpenJobs: (threadId: string) => Promise<Result<JobRow[], ApiError>>;
	appendPersonMessage: (threadId: string, text: string) => Promise<Result<EntryRow | null, ApiError>>;

	getAlert: (alertId: string) => Promise<Result<AlertRow | null, ApiError>>;
	createAlert: (thread: ThreadRow, callId: string, alert: NewAlert) => Promise<Result<AlertRow, ApiError>>;
	listThreadAlerts: (threadId: string) => Promise<Result<AlertRow[], ApiError>>;
	listMemberAlerts: (orgId: string, userId: string) => Promise<Result<ListedAlert[], ApiError>>;
	listPolls: (orgId: string) => Promise<Result<PollRow[], ApiError>>;
	listConnectionsByIds: (orgId: string, ids: string[]) => Promise<Result<ConnectionRow[], ApiError>>;
	endAlert: (threadId: string, alertId: string, by: AlertEnd, now: Date) => Promise<Result<boolean, ApiError>>;
	deleteAlert: (orgId: string, userId: string, alertId: string) => Promise<Result<boolean, ApiError>>;
	fireAlert: (jobId: string, workerId: string, alertId: string, text: string) => Promise<Result<boolean, ApiError>>;

	claimPoll: (workerId: string, leaseMs: number) => Promise<Result<PollRow | null, ApiError>>;
	renewPollLease: (pollId: string, workerId: string, leaseMs: number) => Promise<Result<boolean, ApiError>>;
	listPollRules: (connectionId: string, collectionId: string) => Promise<Result<AlertRow[], ApiError>>;
	deletePoll: (pollId: string) => Promise<Result<void, ApiError>>;
	finishPoll: (pollId: string, workerId: string, outcome: PollOutcome) => Promise<Result<boolean, ApiError>>;
	dropConnectionFromWatches: (connectionId: string, collectionId: string, tell: (alert: AlertRow) => string) => Promise<Result<void, ApiError>>;
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
export const harnessStore: HarnessStore = {
	claimJob: harness.claimJob,
	renewLease: harness.renewLease,
	finishJob: harness.finishJob,
	failJob: (jobId, workerId, error, noteFor) => harness.failJob(jobId, workerId, error, noteFor, readyForInference),
	requeueJob: (jobId, workerId, threadId, runAt, why) => harness.requeueJob(jobId, workerId, threadId, runAt, why, readyForInference),

	getJobThread: harness.getJobThread,
	getThreadAgent: harness.getThreadAgent,
	listEntries: harness.listEntries,
	getEntry: harness.getEntry,
	appendSummary: harness.appendSummary,
	completeInference: (jobId, workerId, threadId, turn, after) => harness.completeInference(jobId, workerId, threadId, turn, after, readyForInference),
	completeToolJob: (jobId, workerId, threadId, result) => harness.completeToolJob(jobId, workerId, threadId, result, readyForInference),
	startSubAgent: (jobId, workerId, parent, start) => harness.startSubAgent(jobId, workerId, parent, start, readyForInference),
	setThreadTask: harness.setThreadTask,
	getAgentTask,
	createAgentTask,

	listPersonas: harness.listPersonas,
	ensureFirstPersona: harness.ensureFirstPersona,
	getPersona: harness.getPersona,
	createPersona: harness.createPersona,
	updatePersona: harness.updatePersona,
	deletePersona: harness.deletePersona,
	getMemberThread: harness.getMemberThread,
	ensureMemberThread: harness.ensureMemberThread,
	listShownEntries: harness.listShownEntries,
	listOpenJobs: harness.listOpenJobs,
	appendPersonMessage: (threadId, text) => harness.appendPersonMessage(threadId, text, readyForInference),

	getAlert: harness.getAlert,
	createAlert: harness.createAlert,
	listThreadAlerts: harness.listThreadAlerts,
	listMemberAlerts: harness.listMemberAlerts,
	listPolls: harness.listPolls,
	listConnectionsByIds,
	endAlert: harness.endAlert,
	deleteAlert: harness.deleteAlert,
	fireAlert: (jobId, workerId, alertId, text) => harness.fireAlert(jobId, workerId, alertId, text, readyForInference),

	claimPoll: harness.claimPoll,
	renewPollLease: harness.renewPollLease,
	listPollRules: harness.listPollRules,
	deletePoll: harness.deletePoll,
	finishPoll: (pollId, workerId, outcome) => harness.finishPoll(pollId, workerId, outcome, matchText, readyForInference),
	dropConnectionFromWatches: (connectionId, collectionId, tell) => harness.dropConnectionFromWatches(connectionId, collectionId, tell, readyForInference),
	getPollConnection: getConnectionWithCredentialById,
	logPoll: logProxyAction,
};
