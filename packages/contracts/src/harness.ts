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
 * it, a name, a head, a look in one of the colors, and what runs it, its sub-agents too: the
 * harness, by its id, and the model it answers with, one of that harness's, by its id
 * (`chatHarnessSchema`). With the harness left out, a new one gets the server's first and one
 * changed keeps its own; with the model left out, it is the harness's first, or the persona's own
 * where the harness stays. One the server hasn't got is refused.
 */
export const personaBodySchema = z.object({
	name: z.string().trim().pipe(z.string().min(1).max(AGENT_NAME_MAX)),
	look: lookSchema,
	color: z.enum(AVATAR_COLORS),
	harness: z.string().optional(),
	chatModel: z.string().optional(),
});

export type Persona = z.input<typeof personaBodySchema>;

const speakerSchema = z.enum(['person', 'assistant']);

/** A persona as the page lists it. */
export const chatPersonaSchema = z.object({
	id: z.string(),
	name: z.string(),
	look: lookSchema,
	color: z.enum(AVATAR_COLORS),
	/** The harness that runs it and the model it answers with, by their ids, as this server has them. */
	harness: z.string(),
	chatModel: z.string(),
	/**
	 * Whether the person may rename, reface, switch the harness or the model of, or delete it: they
	 * made it, or own the organization.
	 */
	mayChange: z.boolean(),
	/**
	 * The last thing said in the person's conversation with it, cut to a line, for the list; null
	 * before anything was said.
	 */
	lastMessage: z.object({kind: speakerSchema, text: z.string(), at: z.string()}).nullable(),
	/**
	 * What the person typed in their conversation with it and hasn't sent, cut to a line, for the
	 * list; null without one.
	 */
	draft: z.string().nullable(),
	/** When it was made, which stands for its last activity before anything was said. */
	createdAt: z.string(),
});

export type ChatPersona = z.infer<typeof chatPersonaSchema>;

/**
 * A harness a persona can run on, as the model switcher offers it: its id, what it is called, and
 * the models it answers with, the first its default.
 */
export const chatHarnessSchema = z.object({
	id: z.string(),
	label: z.string(),
	models: z.array(z.object({id: z.string(), label: z.string()})),
});

export type ChatHarness = z.infer<typeof chatHarnessSchema>;

/**
 * `GET chat/personas`: the organization's personas, the one last active in the person's
 * conversation first: the last thing said in it, or, before anything was, its making; and the
 * harnesses this server has for a persona to run on, the first what a new one gets.
 */
export const personaListSchema = z.object({
	personas: z.array(chatPersonaSchema),
	harnesses: z.array(chatHarnessSchema),
});

/**
 * The persona's last answer in one of the person's conversations, cut to a line, which may come
 * before what the person said last, and whether they haven't seen it: the page hasn't shown it to
 * them since it came (`POST chat/personas/:personaId/read`).
 */
export const chatAnswerSchema = z.object({
	personaId: z.string(),
	name: z.string(),
	answer: z.object({id: z.string(), text: z.string()}),
	unread: z.boolean(),
});

export type ChatAnswer = z.infer<typeof chatAnswerSchema>;

/**
 * `GET chat/answers`: the last answer in each of the person's conversations that has one, as
 * every page asks every so often; it makes nothing, where `GET chat/personas` makes General.
 */
export const chatAnswersSchema = z.object({answers: z.array(chatAnswerSchema)});

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
	/** What the person typed in it and hasn't sent (`PUT chat/personas/:personaId/draft`); null without one. */
	draft: z.string().nullable(),
});

export type ThreadLog = z.infer<typeof threadLogSchema>;

const MAX_MESSAGE = 20_000;

/** `POST chat/personas/:personaId/messages`: what the person says to the persona; it is woken. */
export const postMessageBodySchema = z.object({text: z.string().trim().min(1).max(MAX_MESSAGE)});

/**
 * `PUT chat/personas/:personaId/draft`: what the person has typed to the persona and not sent, in
 * place of what was kept; nothing but whitespace forgets it. Sending a message forgets it too.
 */
export const saveDraftBodySchema = z.object({text: z.string().max(MAX_MESSAGE)});

/**
 * `POST chat/personas/:personaId/read`: the persona's answer the page showed the person, which
 * the conversation is read up to.
 */
export const markReadBodySchema = z.object({entryId: z.string().min(1)});

/** What the person said, as a turn of the conversation. */
export const postedMessageSchema = z.object({entry: chatEntrySchema});
