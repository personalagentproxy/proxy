import {z} from 'zod';

import {chatPersonaSchema} from './harness';

/**
 * The inspector (`/api/orgs/:org/chat/…/inspect`), for whoever works on the built-in agent: the
 * person's conversation with a persona as the harness has it, every thread of it with its whole
 * log, its jobs and what happened to each; and, for an answer of the model, the request it was
 * sent. Behind the `debug` experiment beside `harness`.
 */

const toolCallSchema = z.object({id: z.string(), name: z.string(), arguments: z.string()});

export type ToolCall = z.infer<typeof toolCallSchema>;

export const entryKinds = ['person', 'assistant', 'tool_result', 'event', 'summary'] as const;

/** An entry of a thread's log, whole: every kind, what is pending too, with what the model's answer cost. */
export const inspectedEntrySchema = z.object({
	id: z.string(),
	seq: z.number(),
	kind: z.enum(entryKinds),
	text: z.string(),
	toolCalls: z.array(toolCallSchema).nullable(),
	/** A tool_result's or an event's call, by the id the model gave it. */
	callId: z.string().nullable(),
	isError: z.boolean(),
	/** Landed while the model was answering: not in the log it reads until the answer is. */
	pending: z.boolean(),
	inputTokens: z.number().nullable(),
	outputTokens: z.number().nullable(),
	/** A summary's reach: the seq of the last entry it stands for. */
	coversSeq: z.number().nullable(),
	/** Whether the answer kept the system prompt it was sent, which the request route gives. */
	hasSystem: z.boolean(),
	/** The job that wrote the entry; null for what the person wrote. */
	jobId: z.string().nullable(),
	at: z.string(),
});

export type InspectedEntry = z.infer<typeof inspectedEntrySchema>;

export const jobStatuses = ['queued', 'running', 'done', 'failed'] as const;

/** A job as the queue has it, whatever its status. */
export const inspectedJobSchema = z.object({
	id: z.string(),
	threadId: z.string(),
	kind: z.enum(['inference', 'tool']),
	status: z.enum(jobStatuses),
	/** A tool job's call: the entry it is in and the id the model gave it. */
	entryId: z.string().nullable(),
	callId: z.string().nullable(),
	runAt: z.string(),
	/** Which worker holds it, and until when, while it runs. */
	claimedBy: z.string().nullable(),
	leaseExpiresAt: z.string().nullable(),
	attempts: z.number(),
	error: z.string().nullable(),
	createdAt: z.string(),
});

export type InspectedJob = z.infer<typeof inspectedJobSchema>;

/** What happened to a job, one row per happening. */
export const inspectedJobEventSchema = z.object({
	id: z.string(),
	jobId: z.string(),
	threadId: z.string(),
	kind: z.enum(['claimed', 'requeued', 'done', 'failed']),
	workerId: z.string().nullable(),
	/** Why, on failed, and on requeued. */
	error: z.string().nullable(),
	at: z.string(),
});

export type InspectedJobEvent = z.infer<typeof inspectedJobEventSchema>;

/** Where the thread stands for the harness: whether its log is ready for the model and what holds it back, the model's steps alone against the limit, and how close the log is to being summarized. */
export const threadStateSchema = z.object({
	ready: z.boolean(),
	pendingCalls: z.array(toolCallSchema),
	turnsAlone: z.number(),
	maxTurnsAlone: z.number(),
	lastInputTokens: z.number(),
	compactAtTokens: z.number(),
	/** The seq of the last entry a summary made now would cover; null when the log needs none. */
	compactionCoversSeq: z.number().nullable(),
});

export type ThreadState = z.infer<typeof threadStateSchema>;

/** A thread of the conversation: the conversation itself, or a sub-agent started from it. */
export const inspectedThreadSchema = z.object({
	id: z.string(),
	parentThreadId: z.string().nullable(),
	parentCallId: z.string().nullable(),
	title: z.string().nullable(),
	taskId: z.string().nullable(),
	createdAt: z.string(),
	entries: z.array(inspectedEntrySchema),
	jobs: z.array(inspectedJobSchema),
	events: z.array(inspectedJobEventSchema),
	state: threadStateSchema,
});

export type InspectedThread = z.infer<typeof inspectedThreadSchema>;

/** `GET chat/personas/:personaId/inspect`: the conversation whole, its thread first, then every sub-agent started from it, oldest first. */
export const inspectionSchema = z.object({
	persona: chatPersonaSchema,
	now: z.string(),
	threads: z.array(inspectedThreadSchema),
});

export type Inspection = z.infer<typeof inspectionSchema>;

/** The conversation as the model reads it, in the chat completions form. */
export const modelMessageSchema = z.discriminatedUnion('role', [
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

export type ModelMessage = z.infer<typeof modelMessageSchema>;

/** A tool as the model is given it: its name, what it does, and the JSON Schema of its arguments. */
export const modelToolSchema = z.object({
	name: z.string(),
	description: z.string(),
	parameters: z.unknown(),
});

export type ModelTool = z.infer<typeof modelToolSchema>;

/** `GET chat/inspect/entries/:entryId/request`: what the model was sent for an assistant or summary entry, rebuilt from the log as it was. */
export const modelRequestSchema = z.object({
	kind: z.enum(['turn', 'summary']),
	/** The system prompt as kept; null where the answer was written without the model. */
	system: z.string().nullable(),
	messages: z.array(modelMessageSchema),
	tools: z.array(modelToolSchema),
});

export type ModelRequest = z.infer<typeof modelRequestSchema>;
