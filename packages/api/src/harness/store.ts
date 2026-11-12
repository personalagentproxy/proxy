import type {Result} from 'ts-results-es';

import type {ApiError} from '@proxy/utils';
import {readyForInference} from '@proxy/utils/harness';
import type {EntryAttachment} from '@proxy/utils/harness-context';
import * as alerts from '@proxy/db/alerts';
import type {AlertRow, NewAlert, PollRow, WatchMatch} from '@proxy/db/alerts';
import {type ConnectionRow, getConnectionWithCredentialById, listConnectionsByIds} from '@proxy/db/connection';
import * as harness from '@proxy/db/harness';
import type {
	ActiveTaskRow,
	AfterAnswer,
	AssistantTurn,
	AttachmentRow,
	CappedHarness,
	ClaimedJob,
	ConversationAnswer,
	DraftAttachment,
	EntryRow,
	FailureNote,
	InlineJob,
	JobRow,
	LastMessage,
	NewEntry,
	NewTurnEntry,
	Persona,
	PersonaModel,
	PersonaRow,
	PinnedTaskRow,
	SubAgentRow,
	SubAgentStart,
	ThreadRow,
	ThreadSession,
} from '@proxy/db/harness';
import * as transcripts from '@proxy/db/harness-transcript';
import type {TranscriptKey, TranscriptLine} from '@proxy/db/harness-transcript';
import {type AgentTaskRow, createAgentTask, getAgentTask, type NewAgentTask} from '@proxy/db/task';
import type {SignedInAgent} from '@proxy/db/agent';

/**
 * What the harness reads and writes: the job queue, each thread's log and its jobs, the Chat
 * page's personas, and the alerts set in the conversations with the polls their watches read, in
 * the database (@proxy/db/harness, @proxy/db/alerts). Every write is one transaction, fenced by
 * the worker's lease where it is a job's, and takes what it writes as the harness composed it:
 * the rules of the conversation are the harness's own (conversation.ts). The agent is woken where
 * what lands leaves its log ready for it (@proxy/utils/harness readyForInference). Each part of
 * the harness takes the store, or the part of it it uses, so its tests give it a fake one. A turn
 * whose harness runs its tools itself writes its output as it goes (`appendTurnEntries`), does
 * what its calls do beside the log in transactions of their own, each fenced by the job (the
 * `Inline` methods), has the thread woken after a sleep it answered (`scheduleWake`), and leaves
 * its session on the thread as the job ends; the Claude Agent SDK's transcripts are kept through
 * the transcript methods (session-store.ts), the model's memory beside the log.
 */
export type HarnessStore = {
	claimJob: (workerId: string, leaseMs: number, capped?: CappedHarness | null) => Promise<Result<ClaimedJob | null, ApiError>>;
	renewLease: (jobId: string, workerId: string, leaseMs: number) => Promise<Result<boolean, ApiError>>;
	finishJob: (jobId: string, workerId: string) => Promise<Result<boolean, ApiError>>;
	failJob: (jobId: string, workerId: string, error: string, noteFor: (job: JobRow, thread: ThreadRow) => FailureNote | null) => Promise<Result<boolean, ApiError>>;
	requeueJob: (jobId: string, workerId: string, threadId: string, runAt: Date, why: string) => Promise<Result<boolean, ApiError>>;

	getJobThread: (threadId: string) => Promise<Result<ThreadRow | null, ApiError>>;
	getThreadAgent: (thread: ThreadRow) => Promise<Result<SignedInAgent | null, ApiError>>;
	getPersonaModel: (thread: ThreadRow) => Promise<Result<PersonaModel | null, ApiError>>;
	listEntries: (threadId: string) => Promise<Result<EntryRow[], ApiError>>;
	getEntry: (entryId: string) => Promise<Result<EntryRow, ApiError>>;
	appendSummary: (jobId: string, workerId: string, threadId: string, summary: {text: string; inputTokens: number; outputTokens: number}, coversSeq: number) => Promise<Result<boolean, ApiError>>;
	appendTurnEntries: (jobId: string, workerId: string, threadId: string, entries: NewTurnEntry[]) => Promise<Result<boolean, ApiError>>;
	scheduleWake: (jobId: string, workerId: string, threadId: string, runAt: Date) => Promise<Result<boolean, ApiError>>;
	startSubAgentInline: (job: InlineJob, start: SubAgentStart) => Promise<Result<string | null, ApiError>>;
	messageSubAgentInline: (job: InlineJob, subAgentId: string, entry: NewEntry) => Promise<Result<{subAgent: SubAgentRow | null} | null, ApiError>>;
	tellParentInline: (job: InlineJob, message: {text: string; isError: boolean}) => Promise<Result<boolean, ApiError>>;
	completeInference: (jobId: string, workerId: string, threadId: string, turn: AssistantTurn | null, after: AfterAnswer, session?: ThreadSession) => Promise<Result<boolean, ApiError>>;
	completeToolJob: (jobId: string, workerId: string, threadId: string, result: {callId: string; text: string; isError: boolean}) => Promise<Result<boolean, ApiError>>;
	listSubAgents: (parentThreadId: string, now: Date) => Promise<Result<SubAgentRow[], ApiError>>;
	setThreadTask: (threadId: string, taskId: string) => Promise<Result<void, ApiError>>;
	getAgentTask: (orgId: string, agentId: string, taskId: string) => Promise<Result<AgentTaskRow | null, ApiError>>;
	createAgentTask: (task: NewAgentTask) => Promise<Result<AgentTaskRow | null, ApiError>>;

	listPersonas: (orgId: string, userId: string) => Promise<Result<Array<PersonaRow & {lastMessage: LastMessage | null; draft: string | null; draftAttachments: DraftAttachment[]}>, ApiError>>;
	listAnswers: (orgId: string, userId: string) => Promise<Result<ConversationAnswer[], ApiError>>;
	ensureFirstPersona: (orgId: string) => Promise<Result<PersonaRow, ApiError>>;
	getPersona: (orgId: string, userId: string, personaId: string) => Promise<Result<PersonaRow | null, ApiError>>;
	createPersona: (orgId: string, userId: string, persona: Persona) => Promise<Result<PersonaRow, ApiError>>;
	updatePersona: (orgId: string, personaId: string, persona: Persona) => Promise<Result<boolean, ApiError>>;
	deletePersona: (orgId: string, personaId: string) => Promise<Result<boolean, ApiError>>;
	getMemberThread: (personaId: string, userId: string) => Promise<Result<ThreadRow | null, ApiError>>;
	ensureMemberThread: (data: {orgId: string; agentId: string; personaId: string; userId: string}) => Promise<Result<ThreadRow, ApiError>>;
	listShownEntries: (threadId: string, calls: string[]) => Promise<Result<EntryRow[], ApiError>>;
	listShownSubAgentEntries: (subAgent: ThreadRow, calls: string[]) => Promise<Result<EntryRow[], ApiError>>;
	listOpenJobs: (threadId: string) => Promise<Result<JobRow[], ApiError>>;
	/** What the person says in their conversation, with the files they attached to it. */
	appendPersonMessage: (threadId: string, text: string, attachments?: EntryAttachment[]) => Promise<Result<EntryRow | null, ApiError>>;
	/** What the person attached in a thread, each with the entry it was said with. */
	listAttachments: (threadId: string) => Promise<Result<AttachmentRow[], ApiError>>;
	/** What the person writes in a sub-agent's chat, with the files they attached to it. */
	messageSubAgentDirectly: (conversationId: string, subAgentId: string, text: string, attachments?: EntryAttachment[]) => Promise<Result<boolean, ApiError>>;
	listPinnedTasks: (orgId: string, userId: string) => Promise<Result<PinnedTaskRow[], ApiError>>;
	listActiveTasks: (orgId: string, userId: string) => Promise<Result<ActiveTaskRow[], ApiError>>;
	setTaskPinned: (conversationId: string, subAgentId: string, pinned: boolean) => Promise<Result<boolean, ApiError>>;
	markThreadRead: (threadId: string, entryId: string) => Promise<Result<boolean, ApiError>>;
	getThreadDraft: (threadId: string) => Promise<Result<string | null, ApiError>>;
	saveThreadDraft: (threadId: string, draft: string | null, order?: Array<Pick<DraftAttachment, 'connectionId' | 'fileId' | 'version'>>) => Promise<Result<boolean, ApiError>>;
	/** The files in a conversation's input, not sent yet; put there after those there, at most `max`, and taken out. False for no such conversation. */
	listDraftAttachments: (threadId: string) => Promise<Result<DraftAttachment[], ApiError>>;
	addDraftAttachment: (threadId: string, attachment: DraftAttachment, max: number) => Promise<Result<boolean, ApiError>>;
	removeDraftAttachment: (threadId: string, file: Pick<DraftAttachment, 'connectionId' | 'fileId' | 'version'>) => Promise<Result<boolean, ApiError>>;

	completeSetAlert: (job: {jobId: string; workerId: string; threadId: string; callId: string}, alert: NewAlert, answer: (alert: AlertRow) => string) => Promise<Result<boolean, ApiError>>;
	setAlertInline: (job: InlineJob, alert: NewAlert) => Promise<Result<AlertRow | null, ApiError>>;
	deleteAlert: (alertId: string, owner: {threadId: string} | {orgId: string; userId: string}) => Promise<Result<boolean, ApiError>>;
	listThreadAlerts: (threadId: string) => Promise<Result<AlertRow[], ApiError>>;
	listMemberAlerts: (orgId: string, userId: string) => Promise<Result<Array<AlertRow & {persona: PersonaRow}>, ApiError>>;
	listConnectionsByIds: (orgId: string, ids: string[]) => Promise<Result<ConnectionRow[], ApiError>>;
	claimDueAlerts: (everyMs: number, limit: number) => Promise<Result<AlertRow[], ApiError>>;
	fireAlert: (alert: AlertRow, text: string) => Promise<Result<boolean, ApiError>>;
	claimDuePolls: (everyMs: number, limit: number) => Promise<Result<PollRow[], ApiError>>;
	listWatches: (connectionId: string, collectionId: string) => Promise<Result<AlertRow[], ApiError>>;
	recordLook: (poll: PollRow, cursor: string, matched: WatchMatch[], at: Date) => Promise<Result<boolean, ApiError>>;
	getPollConnection: (connectionId: string) => Promise<Result<(ConnectionRow & {credential: string | null}) | null, ApiError>>;

	appendTranscript: (key: TranscriptKey, lines: TranscriptLine[]) => Promise<Result<void, ApiError>>;
	loadTranscript: (key: TranscriptKey) => Promise<Result<string[] | null, ApiError>>;
	listTranscriptSubkeys: (key: {projectKey: string; sessionId: string}) => Promise<Result<string[], ApiError>>;
	deleteTranscript: (key: TranscriptKey) => Promise<Result<void, ApiError>>;
};

/** What the SDK's session store adapter needs of the store: the transcripts. */
export type TranscriptStore = Pick<HarnessStore, 'appendTranscript' | 'loadTranscript' | 'listTranscriptSubkeys' | 'deleteTranscript'>;

/** The store in the database. */
export const harnessStore: HarnessStore = {
	claimJob: harness.claimJob,
	renewLease: harness.renewLease,
	finishJob: harness.finishJob,
	failJob: (jobId, workerId, error, noteFor) => harness.failJob(jobId, workerId, error, noteFor, readyForInference),
	requeueJob: (jobId, workerId, threadId, runAt, why) => harness.requeueJob(jobId, workerId, threadId, runAt, why, readyForInference),

	getJobThread: harness.getJobThread,
	getThreadAgent: harness.getThreadAgent,
	getPersonaModel: harness.getThreadPersonaModel,
	listEntries: harness.listEntries,
	getEntry: harness.getEntry,
	appendSummary: harness.appendSummary,
	appendTurnEntries: harness.appendTurnEntries,
	scheduleWake: harness.scheduleWake,
	startSubAgentInline: (job, start) => harness.startSubAgentInline(job, start, readyForInference),
	messageSubAgentInline: (job, subAgentId, entry) => harness.messageSubAgentInline(job, subAgentId, entry, readyForInference),
	tellParentInline: (job, message) => harness.tellParentInline(job, message, readyForInference),
	completeInference: (jobId, workerId, threadId, turn, after, session) => harness.completeInference(jobId, workerId, threadId, turn, after, readyForInference, session),
	completeToolJob: (jobId, workerId, threadId, result) => harness.completeToolJob(jobId, workerId, threadId, result, readyForInference),
	listSubAgents: harness.listSubAgents,
	setThreadTask: harness.setThreadTask,
	getAgentTask,
	createAgentTask,

	listPersonas: harness.listPersonas,
	listAnswers: harness.listAnswers,
	ensureFirstPersona: harness.ensureFirstPersona,
	getPersona: harness.getPersona,
	createPersona: harness.createPersona,
	updatePersona: harness.updatePersona,
	deletePersona: harness.deletePersona,
	getMemberThread: harness.getMemberThread,
	ensureMemberThread: harness.ensureMemberThread,
	listShownEntries: harness.listShownEntries,
	listShownSubAgentEntries: harness.listShownSubAgentEntries,
	listOpenJobs: harness.listOpenJobs,
	appendPersonMessage: (threadId, text, attachments) => harness.appendPersonMessage(threadId, text, readyForInference, attachments),
	listAttachments: harness.listAttachments,
	messageSubAgentDirectly: (conversationId, subAgentId, text, attachments) => harness.messageSubAgentDirectly(conversationId, subAgentId, text, readyForInference, attachments),
	listPinnedTasks: harness.listPinnedTasks,
	listActiveTasks: harness.listActiveTasks,
	setTaskPinned: harness.setTaskPinned,
	markThreadRead: harness.markThreadRead,
	getThreadDraft: harness.getThreadDraft,
	saveThreadDraft: harness.saveThreadDraft,
	listDraftAttachments: harness.listDraftAttachments,
	addDraftAttachment: harness.addDraftAttachment,
	removeDraftAttachment: harness.removeDraftAttachment,

	completeSetAlert: (job, alert, answer) => alerts.completeSetAlert(job, alert, answer, readyForInference),
	setAlertInline: alerts.setAlertInline,
	deleteAlert: alerts.deleteAlert,
	listThreadAlerts: alerts.listThreadAlerts,
	listMemberAlerts: alerts.listMemberAlerts,
	listConnectionsByIds,
	claimDueAlerts: alerts.claimDueAlerts,
	fireAlert: (alert, text) => alerts.fireAlert(alert, text, readyForInference),
	claimDuePolls: alerts.claimDuePolls,
	listWatches: alerts.listWatches,
	recordLook: (poll, cursor, matched, at) => alerts.recordLook(poll, cursor, matched, at, readyForInference),
	getPollConnection: getConnectionWithCredentialById,

	appendTranscript: transcripts.appendTranscript,
	loadTranscript: transcripts.loadTranscript,
	listTranscriptSubkeys: transcripts.listTranscriptSubkeys,
	deleteTranscript: transcripts.deleteTranscript,
};
