import {AVATAR_COLORS, AVATAR_SHAPES} from '@proxy/utils/harness';
import {z} from 'zod';
import {apiRequest, apiSend} from '@/client/request';

// The Chat page's api: the person's threads with the built-in agent, each a persona they named
// and gave a face, a thread's log, and what they say in it.

// A persona as the person makes or changes it.
const personaSchema = z.object({
	name: z.string(),
	shape: z.enum(AVATAR_SHAPES),
	color: z.enum(AVATAR_COLORS),
});

const threadSchema = personaSchema.extend({
	id: z.string(),
	createdAt: z.string(),
	// The task every call in the thread is made for, which the activity log can be narrowed to.
	taskId: z.string(),
	// The last thing said in it, by the person or the agent, for the list; null before anything was.
	lastMessage: z
		.object({kind: z.enum(['person', 'assistant']), text: z.string(), at: z.string()})
		.nullable(),
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

export type Persona = z.infer<typeof personaSchema>;
export type ChatThread = z.infer<typeof threadSchema>;
export type ChatEntry = z.infer<typeof entrySchema>;
export type ChatToolCall = z.infer<typeof toolCallSchema>;
export type ThreadLog = z.infer<typeof threadLogSchema>;

export function listThreads() {
	return apiRequest('GET', '/api/chat/threads', z.object({threads: z.array(threadSchema)}));
}

export function createThread(persona: Persona) {
	return apiRequest('POST', '/api/chat/threads', z.object({thread: threadSchema}), persona);
}

export function updateThread(threadId: string, persona: Persona) {
	return apiRequest(
		'PUT',
		`/api/chat/threads/${threadId}`,
		z.object({thread: threadSchema}),
		persona,
	);
}

export function deleteThread(threadId: string) {
	return apiSend('DELETE', `/api/chat/threads/${threadId}`);
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
