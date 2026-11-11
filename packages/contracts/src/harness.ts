import {AGENT_NAME_MAX} from '@proxy/utils/agent-providers';
import {AVATAR_COLORS, lookSchema} from '@proxy/utils/harness';
import {z} from 'zod';

/**
 * The Chat page (`/api/orgs/:org/chat/…`): the personas the person sees in the organization,
 * their own and General, which every member does, each named and given a head, the person's own
 * conversation with each, its turns, and what they say in it.
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
	/** Every member's, as General is, rather than the person's own, which nobody else sees. */
	shared: z.boolean(),
	/**
	 * Whether the person may rename, reface, switch the harness or the model of, or delete it: it
	 * is their own, or one every member sees that they made or whose organization they own.
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
	/** Whether this member pinned their conversation with it to the Chat sidebar. */
	pinned: z.boolean(),
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
 * A sub-agent the persona started in the conversation, which the person sees as a task of its,
 * with a chat of its own (`GET chat/personas/:personaId/tasks/:taskId`): its id, and its title, as
 * the persona gave it.
 */
export const chatTaskSchema = z.object({id: z.string(), title: z.string()});

export type ChatTask = z.infer<typeof chatTaskSchema>;

/** A task the person pinned to the list, under the persona whose conversation it is of. */
export const pinnedTaskSchema = chatTaskSchema.extend({personaId: z.string()});

export type PinnedTask = z.infer<typeof pinnedTaskSchema>;

/**
 * `GET chat/personas`: the organization's personas, pinned conversations first, each group with
 * the one last active in the person's conversation first: the last thing said in it, or, before
 * anything was, its making; the tasks the person pinned in their conversations, the one with
 * something said in it last first; and the harnesses this server has for a persona to run on, the
 * first what a new one gets.
 */
export const personaListSchema = z.object({
	personas: z.array(chatPersonaSchema),
	pinnedTasks: z.array(pinnedTaskSchema),
	harnesses: z.array(chatHarnessSchema),
});

/** `PUT chat/personas/:personaId/tasks/:taskId/pin`: the task pinned to the list, or unpinned. */
export const pinTaskBodySchema = z.object({pinned: z.boolean()});

/** `PUT chat/personas/:personaId/pin`: the member's conversation pinned to the Chat sidebar, or unpinned. */
export const pinChatBodySchema = z.object({pinned: z.boolean()});

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
 * A file attached to what the person said: one of a drive's, by its connection and its id there,
 * at the version it held when it was attached, with its name, media type and size in bytes as
 * they were, whether a browser may show it in place, as a picture, and whether that version is
 * gone from the drive since, deleted for good, so that only its name is left.
 */
export const chatAttachmentSchema = z.object({
	connectionId: z.string(),
	fileId: z.string(),
	version: z.string(),
	name: z.string(),
	type: z.string(),
	size: z.number(),
	shown: z.boolean(),
	gone: z.boolean(),
});

export type ChatAttachment = z.infer<typeof chatAttachmentSchema>;

/**
 * A turn of the conversation as the page shows it: what the person said, with the files they
 * attached to it, or what the persona answered, which is what went wrong where its turn failed.
 */
export const chatMessageSchema = z.object({
	id: z.string(),
	kind: speakerSchema,
	text: z.string(),
	isError: z.boolean(),
	at: z.string(),
	attachments: z.array(chatAttachmentSchema),
});

export type ChatMessage = z.infer<typeof chatMessageSchema>;

/**
 * Something of the conversation as the page shows it: a turn (`chatMessageSchema`); a task the
 * persona started, where it started it, which opens the task's chat; or a message the persona sent
 * to a task it started before, where it sent it, which leads back to that task. What else the
 * persona and its tasks did is in the activity log, not here.
 */
export const chatEntrySchema = z.union([
	chatMessageSchema,
	z.object({id: z.string(), kind: z.literal('task'), task: chatTaskSchema, at: z.string()}),
	z.object({id: z.string(), kind: z.literal('sent'), task: chatTaskSchema, at: z.string()}),
]);

export type ChatEntry = z.infer<typeof chatEntrySchema>;

/**
 * `GET chat/personas/:personaId/thread`: the person's conversation with a persona, the persona,
 * its turns, and what the persona is up to.
 */
export const threadLogSchema = z.object({
	persona: chatPersonaSchema,
	entries: z.array(chatEntrySchema),
	/** Whether the persona is at work on the conversation, sub-agents included, as against asleep or waiting for the person. */
	busy: z.boolean(),
	/** What the person typed in it and hasn't sent (`PUT chat/personas/:personaId/draft`); null without one. */
	draft: z.string().nullable(),
	/**
	 * The files the person put in its input and hasn't sent, in the order they were put there
	 * (`POST` and `DELETE chat/personas/:personaId/attachments`), kept as the draft is.
	 */
	draftAttachments: z.array(chatAttachmentSchema),
});

export type ThreadLog = z.infer<typeof threadLogSchema>;

const MAX_MESSAGE = 20_000;

/** How many files one message carries at most. */
export const MAX_ATTACHMENTS = 10;

/** A file of a drive, by its connection, its id there and a version of it: what a message names to attach it. */
const attachmentRefSchema = z.object({
	connectionId: z.string().min(1),
	fileId: z.string().min(1),
	version: z.string().min(1),
});

/**
 * `POST chat/personas/:personaId/messages`: what the person says to the persona, and the files
 * they attach to it, each one of a drive they use, by its connection, its id and the version to
 * attach; words, files, or both. A file sits among the words where the text has a mark for it
 * (`ATTACHMENT_MARK` in `@proxy/utils/harness`), the first mark the first file's and so on; files
 * the text has no mark for come before the words. The persona is woken.
 * `POST chat/personas/:personaId/tasks/:taskId/messages`: what the person writes to one of its
 * tasks, in the task's chat, with the files they attach to it; the task is woken, and the persona
 * told, but not woken by it.
 */
export const postMessageBodySchema = z
	.object({
		text: z.string().trim().max(MAX_MESSAGE),
		attachments: z.array(attachmentRefSchema).max(MAX_ATTACHMENTS).default([]),
	})
	.refine(({text, attachments}) => text !== '' || attachments.length > 0, {
		message: 'Say something, or attach a file',
	});

/**
 * `POST chat/personas/:personaId/attachments?name=&type=`: a file put in the conversation's
 * input, its body the bytes, sent as `application/octet-stream`: kept in the person's own drive,
 * in a folder of the persona's under Chats, and in the conversation's input, after the files
 * there, until the person sends their next message or takes it out. Refused where the input
 * holds as many as a message carries.
 * `POST chat/personas/:personaId/tasks/:taskId/attachments?name=&type=`: a file put in a task's
 * input, kept in the person's own drive as one put in the conversation's is, but in no input on
 * the server: the page holds it until the message it goes with is sent, or it is taken out.
 */
export const uploadAttachmentQuerySchema = z.object({
	name: z.string().trim().min(1).max(255),
	type: z.string().max(200).optional(),
});

/**
 * `DELETE chat/personas/:personaId/attachments`: takes a file out of the conversation's input.
 * The file stays in its drive.
 */
export const removeAttachmentBodySchema = attachmentRefSchema;

export const uploadedAttachmentSchema = z.object({attachment: chatAttachmentSchema});

/**
 * `PUT chat/personas/:personaId/draft`: what the person has typed to the persona and not sent, in
 * place of what was kept; nothing but whitespace forgets it. Sending a message forgets it too.
 * Where the files in the input sit among the words, each at a mark in the text
 * (`ATTACHMENT_MARK` in `@proxy/utils/harness`), `attachments` says which file each mark is, in
 * the order of the marks: the files in the input are kept in that order, any it leaves out after
 * them.
 */
export const saveDraftBodySchema = z.object({
	text: z.string().max(MAX_MESSAGE),
	attachments: z.array(attachmentRefSchema).max(MAX_ATTACHMENTS).optional(),
});

/**
 * `POST chat/personas/:personaId/read`: the persona's answer the page showed the person, which
 * the conversation is read up to.
 */
export const markReadBodySchema = z.object({entryId: z.string().min(1)});

/** What the person said, as a turn of the conversation. */
export const postedMessageSchema = z.object({entry: chatMessageSchema});

/**
 * Something said in a task's chat: by the persona, which started the task, its brief and every
 * message it sent it since; by the person, who wrote to the task there themselves, with the files
 * they attached; or by the
 * task, to the persona, what it answered and told it as it went, or that it failed.
 */
export const taskChatEntrySchema = z.object({
	id: z.string(),
	from: z.enum(['persona', 'person', 'task']),
	text: z.string(),
	isError: z.boolean(),
	at: z.string(),
	/** The files the person attached to what they wrote; none for what the persona or the task said. */
	attachments: z.array(chatAttachmentSchema),
});

export type TaskChatEntry = z.infer<typeof taskChatEntrySchema>;

/**
 * `GET chat/personas/:personaId/tasks/:taskId`: a task the persona started in the person's
 * conversation, as its chat shows it: the persona, the task, whether it is at work, as against
 * asleep or done for now, the task of the activity log its requests are made for now
 * (`/activity/tasks/:id`), null before it made one, and what was said in it.
 */
export const taskChatSchema = z.object({
	persona: chatPersonaSchema,
	task: chatTaskSchema,
	busy: z.boolean(),
	activityTaskId: z.string().nullable(),
	entries: z.array(taskChatEntrySchema),
});

export type TaskChat = z.infer<typeof taskChatSchema>;
