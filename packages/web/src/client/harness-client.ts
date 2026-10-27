import {AVATAR_COLORS, lookSchema} from '@proxy/utils/harness';
import {z} from 'zod';
import {apiRequest, apiSend, orgApi} from '@/client/request';

// The Chat page's api: the organization's personas, each named and given a head, which every
// member sees, the person's own conversation with each, its turns, and what they say in it.

// A persona as the person makes or changes it: its name and its head, a look in a color.
const personaSchema = z.object({
	name: z.string(),
	look: lookSchema,
	color: z.enum(AVATAR_COLORS),
});

const chatPersonaSchema = personaSchema.extend({
	id: z.string(),
	// Whether the person may rename, reface or delete it: they made it, or own the organization.
	mayChange: z.boolean(),
	// The last thing said in the person's conversation with it, for the list; null before anything was.
	lastMessage: z
		.object({kind: z.enum(['person', 'assistant']), text: z.string(), at: z.string()})
		.nullable(),
});

// A turn of the conversation: what the person said, or what the persona answered. What the
// persona did in between is in the activity log, not here.
const entrySchema = z.object({
	id: z.string(),
	kind: z.enum(['person', 'assistant']),
	text: z.string(),
	at: z.string(),
});

const threadLogSchema = z.object({
	persona: chatPersonaSchema,
	thread: z.object({id: z.string()}),
	entries: z.array(entrySchema),
	// Whether the persona is at work on the conversation, sub-agents included, or asleep until a time.
	busy: z.boolean(),
	sleepingUntil: z.string().nullable(),
});

export type Persona = z.infer<typeof personaSchema>;
export type ChatPersona = z.infer<typeof chatPersonaSchema>;
export type ChatEntry = z.infer<typeof entrySchema>;
export type ThreadLog = z.infer<typeof threadLogSchema>;

export function listPersonas(org: string) {
	return apiRequest(
		'GET',
		`${orgApi(org)}/chat/personas`,
		z.object({personas: z.array(chatPersonaSchema)}),
	);
}

export function createPersona(org: string, persona: Persona) {
	return apiRequest(
		'POST',
		`${orgApi(org)}/chat/personas`,
		z.object({persona: chatPersonaSchema}),
		persona,
	);
}

export function updatePersona(org: string, personaId: string, persona: Persona) {
	return apiRequest(
		'PUT',
		`${orgApi(org)}/chat/personas/${personaId}`,
		z.object({persona: chatPersonaSchema}),
		persona,
	);
}

export function deletePersona(org: string, personaId: string) {
	return apiSend('DELETE', `${orgApi(org)}/chat/personas/${personaId}`);
}

export function getThread(org: string, personaId: string) {
	return apiRequest('GET', `${orgApi(org)}/chat/personas/${personaId}/thread`, threadLogSchema);
}

export function postMessage(org: string, personaId: string, text: string) {
	return apiRequest(
		'POST',
		`${orgApi(org)}/chat/personas/${personaId}/messages`,
		z.object({entry: entrySchema}),
		{text},
	);
}
