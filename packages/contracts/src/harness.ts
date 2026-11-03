import {AGENT_NAME_MAX} from '@proxy/utils/agent-providers';
import {AVATAR_COLORS, lookSchema} from '@proxy/utils/harness';
import {z} from 'zod';

/**
 * The Chat page (`/api/orgs/:org/chat/…`): the organization's personas, each named and given a
 * head, which every member sees, the person's own conversation with each, its turns, and what they
 * say in it.
 */

/**
 * `POST chat/personas`, `PUT chat/personas/:personaId`: a persona as the person makes or changes
 * it, a name, and a head, a look in one of the colors.
 */
export const personaBodySchema = z.object({
	name: z.string().trim().pipe(z.string().min(1).max(AGENT_NAME_MAX)),
	look: lookSchema,
	color: z.enum(AVATAR_COLORS),
});

export type Persona = z.input<typeof personaBodySchema>;

const speakerSchema = z.enum(['person', 'assistant']);

/** A persona as the page lists it. */
export const chatPersonaSchema = z.object({
	id: z.string(),
	name: z.string(),
	look: lookSchema,
	color: z.enum(AVATAR_COLORS),
	/** Whether the person may rename, reface or delete it: they made it, or own the organization. */
	mayChange: z.boolean(),
	/**
	 * The last thing said in the person's conversation with it, cut to a line, for the list; null
	 * before anything was said.
	 */
	lastMessage: z.object({kind: speakerSchema, text: z.string(), at: z.string()}).nullable(),
});

export type ChatPersona = z.infer<typeof chatPersonaSchema>;

/** `GET chat/personas`: the organization's personas, in the order they were made. */
export const personaListSchema = z.object({personas: z.array(chatPersonaSchema)});

/** The persona made or changed. */
export const personaAnswerSchema = z.object({persona: chatPersonaSchema});

/**
 * A turn of the conversation as the page shows it: what the person said, or what the persona
 * answered, which is what went wrong where its turn failed. What the persona did in between is in
 * the activity log, not here.
 */
export const chatEntrySchema = z.object({
	id: z.string(),
	kind: speakerSchema,
	text: z.string(),
	isError: z.boolean(),
	at: z.string(),
});

export type ChatEntry = z.infer<typeof chatEntrySchema>;

/**
 * `GET chat/personas/:personaId/thread`: the person's conversation with a persona, the persona,
 * its turns, and what the persona is up to.
 */
export const threadLogSchema = z.object({
	persona: chatPersonaSchema,
	entries: z.array(chatEntrySchema),
	/** Whether the persona is at work on the conversation, sub-agents included. */
	busy: z.boolean(),
	/** When the persona wakes, where it is asleep; null while it is busy or waiting for the person. */
	sleepingUntil: z.string().nullable(),
});

export type ThreadLog = z.infer<typeof threadLogSchema>;

const MAX_MESSAGE = 20_000;

/** `POST chat/personas/:personaId/messages`: what the person says to the persona; it is woken. */
export const postMessageBodySchema = z.object({text: z.string().trim().min(1).max(MAX_MESSAGE)});

/** What the person said, as a turn of the conversation. */
export const postedMessageSchema = z.object({entry: chatEntrySchema});
