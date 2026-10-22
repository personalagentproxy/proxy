import {z} from 'zod';
import {apiRequest} from '@/client/request';

// The Chat page's api: the person's threads with the built-in agent, a thread's log, and what
// they say in it.

const threadSchema = z.object({
	id: z.string(),
	createdAt: z.string(),
	// The task every call in the thread is made for, which the activity log can be narrowed to.
	taskId: z.string(),
	// What the person first said, as the thread's name; null before they said anything.
	title: z.string().nullable(),
});

const toolCallSchema = z.object({id: z.string(), name: z.string(), arguments: z.string()});

const entrySchema = z.object({
	id: z.string(),
	kind: z.enum(['person', 'assistant', 'tool_result']),
	text: z.string(),
	// An assistant entry's calls; null otherwise.
	toolCalls: z.array(toolCallSchema).nullable(),
	// A tool result's call; null otherwise.
	callId: z.string().nullable(),
	isError: z.boolean(),
	at: z.string(),
});

const threadLogSchema = z.object({
	thread: threadSchema,
	entries: z.array(entrySchema),
	// Whether the agent is at work on the thread, or asleep until a time.
	busy: z.boolean(),
	sleepingUntil: z.string().nullable(),
});

export type ChatThread = z.infer<typeof threadSchema>;
export type ChatEntry = z.infer<typeof entrySchema>;
export type ChatToolCall = z.infer<typeof toolCallSchema>;
export type ThreadLog = z.infer<typeof threadLogSchema>;

export function listThreads() {
	return apiRequest('GET', '/api/chat/threads', z.object({threads: z.array(threadSchema)}));
}

export function createThread() {
	return apiRequest('POST', '/api/chat/threads', z.object({thread: threadSchema}));
}

export function getThread(threadId: string) {
	return apiRequest('GET', `/api/chat/threads/${threadId}`, threadLogSchema);
}

export function postMessage(threadId: string, text: string) {
	return apiRequest(
		'POST',
		`/api/chat/threads/${threadId}/messages`,
		z.object({entry: entrySchema}),
		{
			text,
		},
	);
}
