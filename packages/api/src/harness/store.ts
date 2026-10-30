import type {Result} from 'ts-results-es';

import type {ApiError} from '@proxy/utils';
import {readyForInference} from '@proxy/utils/harness';
import * as harness from '@proxy/db/harness';
import type {AfterAnswer, AssistantTurn, EntryRow, FailureNote, JobRow, LastMessage, Persona, PersonaRow, SubAgentStart, ThreadRow} from '@proxy/db/harness';
import {type AgentTaskRow, createAgentTask, getAgentTask, type NewAgentTask} from '@proxy/db/task';
import type {SignedInAgent} from '@proxy/db/agent';

/**
 * What the harness reads and writes: the job queue, each thread's log and its jobs, and the Chat
 * page's personas, in the database (@proxy/db/harness). Every write is one transaction, fenced by
 * the worker's lease where it is a job's, and takes what it writes as the harness composed it:
 * the rules of the conversation are the harness's own (conversation.ts). The agent is woken where
 * what lands leaves its log ready for it (@proxy/utils/harness readyForInference). Each part of
 * the harness takes the store, or the part of it it uses, so its tests give it a fake one.
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
};
