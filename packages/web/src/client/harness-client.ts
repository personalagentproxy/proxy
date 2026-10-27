import {AVATAR_COLORS, lookSchema} from '@proxy/utils/harness';
import {z} from 'zod';
import {apiRequest, apiSend, orgApi} from '@/client/request';

// The Chat page's api: the organization's built-in agents, each named and given a face, which
// every member sees, the person's own conversation with each, its log, the sub-agents started from
// it, and what they say in it.

// An agent's persona as the person makes or changes it: its name and its head, a look in a color.
const personaSchema = z.object({
	name: z.string(),
	look: lookSchema,
	color: z.enum(AVATAR_COLORS),
});

const agentSchema = personaSchema.extend({
	id: z.string(),
	// Whether the person may rename, reface or delete it: they made it, or own the organization.
	mayChange: z.boolean(),
	// The last thing said in the person's conversation with it, for the list; null before anything was.
	lastMessage: z
		.object({kind: z.enum(['person', 'assistant']), text: z.string(), at: z.string()})
		.nullable(),
});

const toolCallSchema = z.object({id: z.string(), name: z.string(), arguments: z.string()});

const entrySchema = z.object({
	id: z.string(),
	// An event is a sub-agent's report, which came after its call was answered as started.
	kind: z.enum(['person', 'assistant', 'tool_result', 'event']),
	text: z.string(),
	// An assistant entry's calls; null otherwise.
	toolCalls: z.array(toolCallSchema).nullable(),
	// A tool result's or an event's call; null otherwise.
	callId: z.string().nullable(),
	isError: z.boolean(),
	at: z.string(),
});

// A sub-agent started from the conversation: by which call, its title, the task its calls are
// made for, which the activity log can be narrowed to, and when it was done.
const subAgentSchema = z.object({
	callId: z.string(),
	title: z.string(),
	taskId: z.string(),
	finishedAt: z.string().nullable(),
});

const threadLogSchema = z.object({
	agent: agentSchema,
	thread: z.object({id: z.string()}),
	entries: z.array(entrySchema),
	subAgents: z.array(subAgentSchema),
	// Whether the agent is at work on the conversation, sub-agents included, or asleep until a time.
	busy: z.boolean(),
	sleepingUntil: z.string().nullable(),
});

export type Persona = z.infer<typeof personaSchema>;
export type ChatAgent = z.infer<typeof agentSchema>;
export type ChatEntry = z.infer<typeof entrySchema>;
export type ChatToolCall = z.infer<typeof toolCallSchema>;
export type ChatSubAgent = z.infer<typeof subAgentSchema>;
export type ThreadLog = z.infer<typeof threadLogSchema>;

export function listChatAgents(org: string) {
	return apiRequest('GET', `${orgApi(org)}/chat/agents`, z.object({agents: z.array(agentSchema)}));
}

export function createChatAgent(org: string, persona: Persona) {
	return apiRequest('POST', `${orgApi(org)}/chat/agents`, z.object({agent: agentSchema}), persona);
}

export function updateChatAgent(org: string, agentId: string, persona: Persona) {
	return apiRequest(
		'PUT',
		`${orgApi(org)}/chat/agents/${agentId}`,
		z.object({agent: agentSchema}),
		persona,
	);
}

export function deleteChatAgent(org: string, agentId: string) {
	return apiSend('DELETE', `${orgApi(org)}/chat/agents/${agentId}`);
}

export function getThread(org: string, agentId: string) {
	return apiRequest('GET', `${orgApi(org)}/chat/agents/${agentId}/thread`, threadLogSchema);
}

export function postMessage(org: string, agentId: string, text: string) {
	return apiRequest(
		'POST',
		`${orgApi(org)}/chat/agents/${agentId}/messages`,
		z.object({entry: entrySchema}),
		{text},
	);
}
