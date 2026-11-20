import type {Result} from 'ts-results-es';

import type {ApiError} from '@proxy/utils';
import {readyForInference} from '@proxy/utils/harness';
import type {EntryAttachment} from '@proxy/utils/harness-context';
import * as alerts from '@proxy/db/alerts';
import type {AlertRow, Landing, MemberAlertRow, NewAlert, PollRow, WatchMatch} from '@proxy/db/alerts';
import {type ConnectionRow, getConnectionWithCredentialById, listConnectionsByIds} from '@proxy/db/connection';
import * as harness from '@proxy/db/harness';
import type {
	AfterAnswer,
	AssistantTurn,
	AttachmentRow,
	CappedHarness,
	ChatThreadRow,
	ClaimedJob,
	ChatAnswerRow,
	DraftAttachment,
	EntryRow,
	FailureNote,
	InlineJob,
	JobRow,
	LastMessage,
	NewTurnEntry,
	Persona,
	PersonaModel,
	PersonaRow,
	ThreadOpening,
	SaidToParent,
	SubAgentRow,
	SubAgentStart,
	NewEntry,
	ThreadRow,
	ThreadSession,
} from '@proxy/db/harness';
import * as transcripts from '@proxy/db/harness-transcript';
import type {TranscriptKey, TranscriptLine} from '@proxy/db/harness-transcript';
import {type AgentTaskRow, createAgentTask, getAgentTask, type NewAgentTask} from '@proxy/db/task';
import type {SignedInAgent} from '@proxy/db/agent';
import {getUserTimeZone} from '@proxy/db/user';

/**
 * What the harness reads and writes: the job queue, each thread's log and its jobs, the Chat
 * page's personas, the member's chats and their threads, and the alerts set in the threads with
 * the polls their watches read, in the database (@proxy/db/harness, @proxy/db/alerts). Every
 * write is one transaction, fenced by the worker's lease where it is a job's, and takes what it
 * writes as the harness composed it: the rules of a thread are the harness's own
 * (thread-rules.ts). The agent is woken where
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
	failJob: (jobId: string, workerId: string, error: string, noteFor: (job: JobRow) => FailureNote | null) => Promise<Result<boolean, ApiError>>;
	requeueJob: (jobId: string, workerId: string, threadId: string, runAt: Date, why: string) => Promise<Result<boolean, ApiError>>;

	getJobThread: (threadId: string) => Promise<Result<ThreadRow | null, ApiError>>;
	getThreadAgent: (thread: ThreadRow) => Promise<Result<SignedInAgent | null, ApiError>>;
	/** What runs the thread's turns: its own choice, or its persona's where it has none. */
	getThreadModel: (thread: ThreadRow) => Promise<Result<PersonaModel | null, ApiError>>;
	getPersonaName: (thread: ThreadRow) => Promise<Result<string | null, ApiError>>;
	listEntries: (threadId: string) => Promise<Result<EntryRow[], ApiError>>;
	/** What came into the thread while its turn runs that the model can be given beside a call's answer: the person's messages and events without files, pending, in order. */
	listPendingMessages: (threadId: string) => Promise<Result<EntryRow[], ApiError>>;
	getEntry: (entryId: string) => Promise<Result<EntryRow, ApiError>>;
	appendSummary: (jobId: string, workerId: string, threadId: string, summary: {text: string; inputTokens: number; outputTokens: number}, coversSeq: number) => Promise<Result<boolean, ApiError>>;
	appendTurnEntries: (jobId: string, workerId: string, threadId: string, entries: NewTurnEntry[]) => Promise<Result<boolean, ApiError>>;
	scheduleWake: (jobId: string, workerId: string, threadId: string, runAt: Date) => Promise<Result<boolean, ApiError>>;
	completeInference: (jobId: string, workerId: string, threadId: string, turn: AssistantTurn | null, after: AfterAnswer, session?: ThreadSession) => Promise<Result<boolean, ApiError>>;
	completeToolJob: (jobId: string, workerId: string, threadId: string, result: {callId: string; text: string; isError: boolean}) => Promise<Result<boolean, ApiError>>;
	setThreadTask: (threadId: string, taskId: string) => Promise<Result<void, ApiError>>;
	getAgentTask: (orgId: string, agentId: string, taskId: string) => Promise<Result<AgentTaskRow | null, ApiError>>;
	createAgentTask: (task: NewAgentTask) => Promise<Result<AgentTaskRow | null, ApiError>>;

	listPersonas: (
		orgId: string,
		userId: string,
	) => Promise<Result<Array<PersonaRow & {lastMessage: LastMessage | null; draft: string | null; draftAttachments: DraftAttachment[]; pinnedAt: Date | null}>, ApiError>>;
	listAnswers: (orgId: string, userId: string) => Promise<Result<ChatAnswerRow[], ApiError>>;
	ensureFirstPersona: (orgId: string) => Promise<Result<PersonaRow, ApiError>>;
	getPersona: (orgId: string, userId: string, personaId: string) => Promise<Result<PersonaRow | null, ApiError>>;
	createPersona: (orgId: string, userId: string, persona: Persona) => Promise<Result<PersonaRow, ApiError>>;
	updatePersona: (orgId: string, personaId: string, persona: Persona) => Promise<Result<boolean, ApiError>>;
	deletePersona: (orgId: string, personaId: string) => Promise<Result<boolean, ApiError>>;
	getMemberChat: (personaId: string, userId: string) => Promise<Result<ThreadRow | null, ApiError>>;
	ensureMemberChat: (data: {orgId: string; agentId: string; personaId: string; userId: string}) => Promise<Result<ThreadRow, ApiError>>;
	/** What the person attached in a thread, each with the entry it was said with. */
	listAttachments: (threadId: string) => Promise<Result<AttachmentRow[], ApiError>>;
	/** A thread opened in the member's chat with what they said, with the files they attached to it, as its first entry. */
	openThread: (chatId: string, text: string, opening: ThreadOpening, attachments?: EntryAttachment[]) => Promise<Result<{thread: ThreadRow; entry: EntryRow} | null, ApiError>>;
	/** What the member replies in one of their chat's threads, with the files they attached to it. */
	replyInThread: (chatId: string, threadId: string, text: string, attachments?: EntryAttachment[]) => Promise<Result<EntryRow | null, ApiError>>;
	listChatThreads: (chatId: string, calls: string[], now: Date) => Promise<Result<ChatThreadRow[], ApiError>>;
	getChatThread: (chatId: string, threadId: string, calls: string[], now: Date) => Promise<Result<ChatThreadRow | null, ApiError>>;
	hasChatThread: (chatId: string, threadId: string) => Promise<Result<boolean, ApiError>>;
	/** The member switches what runs one of their chat's threads, leaving its persona as it is. */
	setThreadModel: (chatId: string, threadId: string, model: PersonaModel) => Promise<Result<boolean, ApiError>>;
	/** Where a thread stands as its turn ended, written up to `upToSeq` while nothing came since; whether it waits left as it is where not given. */
	writeThreadStanding: (threadId: string, standing: {summary: string | null; waitingForMember?: boolean}, upToSeq: number, atWork?: boolean) => Promise<Result<boolean, ApiError>>;
	/** The member says a thread is done, cancelling the alerts that come to it where they ask to. */
	markThreadDone: (chatId: string, threadId: string, cancelAlerts?: boolean) => Promise<Result<boolean, ApiError>>;
	/** The member archives a thread of their chat: its list no longer has it until something more comes into it, and the alerts that come to it are cancelled. */
	archiveThread: (chatId: string, threadId: string) => Promise<Result<boolean, ApiError>>;
	listThreadsWithoutSummary: () => Promise<Result<Array<{id: string; chatId: string}>, ApiError>>;
	/** Whether the thread is a chat's whose title the small model has yet to write. */
	threadNeedsTitle: (threadId: string) => Promise<Result<boolean, ApiError>>;
	/** The title the small model gave the thread, written once, its task named the same; `Ok(false)` where it was not written. */
	writeThreadTitle: (threadId: string, title: string) => Promise<Result<boolean, ApiError>>;
	/** The member renames a thread of their chat, its task with it; `Ok(false)` for no such thread of the chat. */
	renameThread: (chatId: string, threadId: string, title: string) => Promise<Result<boolean, ApiError>>;
	listThreadsWithoutTitle: () => Promise<Result<Array<{id: string}>, ApiError>>;
	markThreadRead: (chatId: string, entryId: string) => Promise<Result<boolean, ApiError>>;
	getChatDraft: (chatId: string) => Promise<Result<string | null, ApiError>>;
	/** What the member typed in one of their chat's threads and hasn't sent, kept in place of what was; null forgets it. False for no such thread. */
	getThreadDraft: (chatId: string, threadId: string) => Promise<Result<string | null, ApiError>>;
	saveThreadDraft: (chatId: string, threadId: string, draft: string | null) => Promise<Result<boolean, ApiError>>;
	saveChatDraft: (chatId: string, draft: string | null, order?: Array<Pick<DraftAttachment, 'connectionId' | 'fileId' | 'version'>>) => Promise<Result<boolean, ApiError>>;
	/** The member pins their chat to the top of their list, or unpins it; one pinned again keeps its place. False for no such chat. */
	setChatPinned: (chatId: string, pinned: boolean) => Promise<Result<boolean, ApiError>>;
	/** The files in a chat's input, not sent yet; put there after those there, at most `max`, and taken out. False for no such chat. */
	listDraftAttachments: (chatId: string) => Promise<Result<DraftAttachment[], ApiError>>;
	addDraftAttachment: (chatId: string, attachment: DraftAttachment, max: number) => Promise<Result<boolean, ApiError>>;
	removeDraftAttachment: (chatId: string, file: Pick<DraftAttachment, 'connectionId' | 'fileId' | 'version'>) => Promise<Result<boolean, ApiError>>;

	completeSetAlert: (job: {jobId: string; workerId: string; threadId: string; callId: string}, alert: NewAlert, answer: (alert: AlertRow) => string) => Promise<Result<boolean, ApiError>>;
	setAlertInline: (job: InlineJob, alert: NewAlert) => Promise<Result<AlertRow | null, ApiError>>;
	/** The agent of a thread an alert opened dismisses it, archived; false where no alert opened it, or the job is no longer the worker's. */
	dismissThreadInline: (job: InlineJob) => Promise<Result<boolean, ApiError>>;
	/** The sub-agents the thread's agent started, each with what it is up to. */
	listSubAgents: (threadId: string, now: Date) => Promise<Result<SubAgentRow[], ApiError>>;
	/** A sub-agent started mid-turn, its id; null where the job is no longer the worker's. */
	startSubAgentInline: (job: InlineJob, start: SubAgentStart) => Promise<Result<string | null, ApiError>>;
	/** A message to one of the thread's sub-agents mid-turn, with the sub-agent as it was, null for no such sub-agent; null where the job is no longer the worker's. */
	messageSubAgentInline: (job: InlineJob, subAgentId: string, entry: NewEntry) => Promise<Result<{subAgent: SubAgentRow | null} | null, ApiError>>;
	/** What a sub-agent says mid-turn to the thread it works for; false where the job is no longer the worker's. */
	tellParentInline: (job: InlineJob, said: SaidToParent) => Promise<Result<boolean, ApiError>>;
	completeDismiss: (job: {jobId: string; workerId: string; threadId: string; callId: string}, answer: (dismissed: boolean) => {text: string; isError: boolean}) => Promise<Result<boolean, ApiError>>;
	/** The member's time zone, an IANA name; null where they have none set. */
	getUserTimeZone: (userId: string) => Promise<Result<string | null, ApiError>>;
	deleteAlert: (alertId: string, owner: {orgId: string; userId: string}) => Promise<Result<boolean, ApiError>>;
	listMemberAlerts: (orgId: string, userId: string) => Promise<Result<MemberAlertRow[], ApiError>>;
	/** How many of the chat's alerts open a new thread in it each time. */
	countChatAlerts: (chatId: string) => Promise<Result<number, ApiError>>;
	listConnectionsByIds: (orgId: string, ids: string[]) => Promise<Result<ConnectionRow[], ApiError>>;
	claimDueAlerts: (everyMs: number, limit: number) => Promise<Result<AlertRow[], ApiError>>;
	fireAlert: (alert: AlertRow, landing: Landing, next: Date | null) => Promise<Result<boolean, ApiError>>;
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
	getThreadModel: harness.getThreadModel,
	getPersonaName: harness.getThreadPersonaName,
	listEntries: harness.listEntries,
	listPendingMessages: harness.listPendingMessages,
	getEntry: harness.getEntry,
	appendSummary: harness.appendSummary,
	appendTurnEntries: harness.appendTurnEntries,
	scheduleWake: harness.scheduleWake,
	completeInference: (jobId, workerId, threadId, turn, after, session) => harness.completeInference(jobId, workerId, threadId, turn, after, readyForInference, session),
	completeToolJob: (jobId, workerId, threadId, result) => harness.completeToolJob(jobId, workerId, threadId, result, readyForInference),
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
	getMemberChat: harness.getMemberChat,
	ensureMemberChat: harness.ensureMemberChat,
	listAttachments: harness.listAttachments,
	openThread: (chatId, text, opening, attachments) => harness.openThread(chatId, text, opening, readyForInference, attachments),
	replyInThread: (chatId, threadId, text, attachments) => harness.replyInThread(chatId, threadId, text, readyForInference, attachments),
	listChatThreads: harness.listChatThreads,
	getChatThread: harness.getChatThread,
	hasChatThread: harness.hasChatThread,
	setThreadModel: harness.setThreadModel,
	writeThreadStanding: harness.writeThreadStanding,
	markThreadDone: harness.markThreadDone,
	archiveThread: harness.archiveThread,
	listThreadsWithoutSummary: harness.listThreadsWithoutSummary,
	threadNeedsTitle: harness.threadNeedsTitle,
	writeThreadTitle: harness.writeThreadTitle,
	renameThread: harness.renameThread,
	listThreadsWithoutTitle: harness.listThreadsWithoutTitle,
	markThreadRead: harness.markThreadRead,
	getChatDraft: harness.getChatDraft,
	getThreadDraft: harness.getThreadDraft,
	saveThreadDraft: harness.saveThreadDraft,
	saveChatDraft: harness.saveChatDraft,
	setChatPinned: harness.setChatPinned,
	listDraftAttachments: harness.listDraftAttachments,
	addDraftAttachment: harness.addDraftAttachment,
	removeDraftAttachment: harness.removeDraftAttachment,

	completeSetAlert: (job, alert, answer) => alerts.completeSetAlert(job, alert, answer, readyForInference),
	setAlertInline: alerts.setAlertInline,
	dismissThreadInline: harness.dismissThreadInline,
	listSubAgents: harness.listSubAgents,
	startSubAgentInline: (job, start) => harness.startSubAgentInline(job, start, readyForInference),
	messageSubAgentInline: (job, subAgentId, entry) => harness.messageSubAgentInline(job, subAgentId, entry, readyForInference),
	tellParentInline: (job, said) => harness.tellParentInline(job, said, readyForInference),
	completeDismiss: (job, answer) => harness.completeDismiss(job, answer, readyForInference),
	getUserTimeZone,
	deleteAlert: alerts.deleteAlert,
	listMemberAlerts: alerts.listMemberAlerts,
	countChatAlerts: alerts.countChatAlerts,
	listConnectionsByIds,
	claimDueAlerts: alerts.claimDueAlerts,
	fireAlert: (alert, landing, next) => alerts.fireAlert(alert, landing, next, readyForInference),
	claimDuePolls: alerts.claimDuePolls,
	listWatches: alerts.listWatches,
	recordLook: (poll, cursor, matched, at) => alerts.recordLook(poll, cursor, matched, at, readyForInference),
	getPollConnection: getConnectionWithCredentialById,

	appendTranscript: transcripts.appendTranscript,
	loadTranscript: transcripts.loadTranscript,
	listTranscriptSubkeys: transcripts.listTranscriptSubkeys,
	deleteTranscript: transcripts.deleteTranscript,
};
