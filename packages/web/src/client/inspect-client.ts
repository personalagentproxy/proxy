import {z} from 'zod';
import {apiRequest, orgApi} from '@/client/request';
import {chatPersonaSchema} from '@/client/harness-client';

// The inspector's api: the person's conversation with a persona as the harness has it, every
// thread of it with its whole log, its jobs and what happened to each; and, for an answer of the
// model, the request it was sent.

const toolCallSchema = z.object({id: z.string(), name: z.string(), arguments: z.string()});

export const entryKinds = ['person', 'assistant', 'tool_result', 'event', 'summary'] as const;

// An entry of a thread's log, whole: every kind, what is pending too.
const inspectedEntrySchema = z.object({
	id: z.string(),
	seq: z.number(),
	kind: z.enum(entryKinds),
	text: z.string(),
	toolCalls: z.array(toolCallSchema).nullable(),
	callId: z.string().nullable(),
	isError: z.boolean(),
	// Landed while the model was answering: not in the log it reads until the answer is.
	pending: z.boolean(),
	inputTokens: z.number().nullable(),
	outputTokens: z.number().nullable(),
	// A summary's reach: the seq of the last entry it stands for.
	coversSeq: z.number().nullable(),
	// Whether the answer kept the system prompt it was sent, which the request route gives.
	hasSystem: z.boolean(),
	// The job that wrote the entry; null for what the person wrote.
	jobId: z.string().nullable(),
	at: z.string(),
});

export const jobStatuses = ['queued', 'running', 'done', 'failed'] as const;

// A job as the queue has it, whatever its status.
const inspectedJobSchema = z.object({
	id: z.string(),
	threadId: z.string(),
	kind: z.enum(['inference', 'tool']),
	status: z.enum(jobStatuses),
	// A tool job's call: the entry it is in and the id the model gave it.
	entryId: z.string().nullable(),
	callId: z.string().nullable(),
	runAt: z.string(),
	claimedBy: z.string().nullable(),
	leaseExpiresAt: z.string().nullable(),
	attempts: z.number(),
	error: z.string().nullable(),
	createdAt: z.string(),
});

// What happened to a job, one row per happening.
const inspectedJobEventSchema = z.object({
	id: z.string(),
	jobId: z.string(),
	threadId: z.string(),
	kind: z.enum(['claimed', 'requeued', 'done', 'failed']),
	workerId: z.string().nullable(),
	error: z.string().nullable(),
	at: z.string(),
});

// Where the thread stands for the harness.
const threadStateSchema = z.object({
	ready: z.boolean(),
	pendingCalls: z.array(toolCallSchema),
	turnsAlone: z.number(),
	maxTurnsAlone: z.number(),
	lastInputTokens: z.number(),
	compactAtTokens: z.number(),
	compactionCoversSeq: z.number().nullable(),
});

const inspectedThreadSchema = z.object({
	id: z.string(),
	parentThreadId: z.string().nullable(),
	parentCallId: z.string().nullable(),
	title: z.string().nullable(),
	taskId: z.string().nullable(),
	finishedAt: z.string().nullable(),
	createdAt: z.string(),
	entries: z.array(inspectedEntrySchema),
	jobs: z.array(inspectedJobSchema),
	events: z.array(inspectedJobEventSchema),
	state: threadStateSchema,
});

const inspectionSchema = z.object({
	persona: chatPersonaSchema,
	now: z.string(),
	// The conversation first, then every sub-agent started from it, oldest first.
	threads: z.array(inspectedThreadSchema),
});

// The conversation as the model reads it, in the chat completions form.
const modelMessageSchema = z.discriminatedUnion('role', [
	z.object({role: z.literal('system'), content: z.string()}),
	z.object({role: z.literal('user'), content: z.string()}),
	z.object({
		role: z.literal('assistant'),
		content: z.string().nullable(),
		tool_calls: z
			.array(
				z.object({
					id: z.string(),
					type: z.literal('function'),
					function: z.object({name: z.string(), arguments: z.string()}),
				}),
			)
			.optional(),
	}),
	z.object({role: z.literal('tool'), tool_call_id: z.string(), content: z.string()}),
]);

const modelToolSchema = z.object({
	name: z.string(),
	description: z.string(),
	parameters: z.unknown(),
});

const requestSchema = z.object({
	kind: z.enum(['turn', 'summary']),
	// Null where the answer was written without the model.
	system: z.string().nullable(),
	messages: z.array(modelMessageSchema),
	tools: z.array(modelToolSchema),
});

export type ToolCall = z.infer<typeof toolCallSchema>;
export type InspectedEntry = z.infer<typeof inspectedEntrySchema>;
export type InspectedJob = z.infer<typeof inspectedJobSchema>;
export type InspectedJobEvent = z.infer<typeof inspectedJobEventSchema>;
export type ThreadState = z.infer<typeof threadStateSchema>;
export type InspectedThread = z.infer<typeof inspectedThreadSchema>;
export type Inspection = z.infer<typeof inspectionSchema>;
export type ModelMessage = z.infer<typeof modelMessageSchema>;
export type ModelTool = z.infer<typeof modelToolSchema>;
export type ModelRequest = z.infer<typeof requestSchema>;

export function getInspection(org: string, personaId: string) {
	return apiRequest('GET', `${orgApi(org)}/chat/personas/${personaId}/inspect`, inspectionSchema);
}

export function getRequest(org: string, entryId: string) {
	return apiRequest('GET', `${orgApi(org)}/chat/inspect/entries/${entryId}/request`, requestSchema);
}
