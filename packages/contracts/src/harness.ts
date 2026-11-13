import {AGENT_NAME_MAX} from '@proxy/utils/agent-providers';
import {AVATAR_COLORS, lookSchema} from '@proxy/utils/harness';
import {z} from 'zod';

/**
 * The Chat page (`/api/orgs/:org/chat/…`): the personas the person sees in the organization,
 * their own and General, which every member does, each named and given a head, and the person's
 * own chat with each: its threads, each opened by what they said in the chat, and what is said in
 * each.
 */

/**
 * `POST chat/personas`, `PUT chat/personas/:personaId`: a persona as the person makes or changes
 * it, a name, a head, a look in one of the colors, and what runs it in every thread: the harness,
 * by its id, and the model it answers with, one of that harness's, by its id
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
	 * The last thing said in the person's chat with it, in any of its threads, cut to a line, for
	 * the list; null before anything was said.
	 */
	lastMessage: z.object({kind: speakerSchema, text: z.string(), at: z.string()}).nullable(),
	/**
	 * What the person typed in their chat with it and hasn't sent, cut to a line, for the list; null
	 * without one.
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
 * `GET chat/personas`: the organization's personas, the one last active in the person's chat with
 * it first: the last thing said in it, or, before anything was, its making; and the harnesses this
 * server has for a persona to run on, the first what a new one gets.
 */
export const personaListSchema = z.object({
	personas: z.array(chatPersonaSchema),
	harnesses: z.array(chatHarnessSchema),
});

/**
 * The persona's last answer in one of the person's chats, in any of its threads, cut to a line, which may come before what the person said last, and whether they haven't seen
 * it: the page hasn't shown it to them since it came (`POST chat/personas/:personaId/read`).
 */
export const chatAnswerSchema = z.object({
	personaId: z.string(),
	name: z.string(),
	answer: z.object({id: z.string(), text: z.string()}),
	unread: z.boolean(),
});

export type ChatAnswer = z.infer<typeof chatAnswerSchema>;

/**
 * `GET chat/answers`: the last answer in each of the person's chats that has one, as every page
 * asks every so often; it makes nothing, where `GET chat/personas` makes General.
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
 * `POST chat/personas/:personaId/threads` and `POST chat/personas/:personaId/threads/:threadId/messages`:
 * what the person says, in the chat, which opens a thread, or in a thread, and the files they
 * attach to it, each one of a drive they use, by its connection, its id and the version to attach;
 * words, files, or both. A file sits among the words where the text has a mark for it
 * (`ATTACHMENT_MARK` in `@proxy/utils/harness`), the first mark the first file's and so on; files
 * the text has no mark for come before the words. The thread's persona is woken.
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
 * `POST chat/personas/:personaId/attachments?name=&type=`: a file put in the chat's input, its
 * body the bytes, sent as `application/octet-stream`: kept in the person's own drive, in a folder
 * of the persona's under Chats, and in the chat's input, after the files there, until the person
 * sends their next message or takes it out. Refused where the input holds as many as a message
 * carries.
 * `POST chat/personas/:personaId/threads/:threadId/attachments?name=&type=`: a file put in a
 * thread's input, kept in the person's own drive as one put in the chat's is, but in no input on
 * the server: the page holds it until the reply it goes with is sent, or it is taken out.
 */
export const uploadAttachmentQuerySchema = z.object({
	name: z.string().trim().min(1).max(255),
	type: z.string().max(200).optional(),
});

/**
 * `DELETE chat/personas/:personaId/attachments`: takes a file out of the chat's input. The file
 * stays in its drive.
 */
export const removeAttachmentBodySchema = attachmentRefSchema;

export const uploadedAttachmentSchema = z.object({attachment: chatAttachmentSchema});

/**
 * `PUT chat/personas/:personaId/draft`: what the person has typed in the chat and not sent, in
 * place of what was kept; nothing but whitespace forgets it. Opening a thread forgets it too.
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
 * `POST chat/personas/:personaId/read`: the persona's answer the page showed the person, in the
 * chat or one of its threads, which the chat is read up to.
 */
export const markReadBodySchema = z.object({entryId: z.string().min(1)});

/**
 * What one of the chat's threads is up to: at work; asleep until a time, woken then or by a reply;
 * or stopped, until the person replies or an alert set in it comes.
 */
export const chatThreadStateSchema = z.discriminatedUnion('kind', [
	z.object({kind: z.literal('working')}),
	z.object({kind: z.literal('asleep'), until: z.string()}),
	z.object({kind: z.literal('stopped')}),
]);

export type ChatThreadState = z.infer<typeof chatThreadStateSchema>;

/**
 * Where one of the chat's threads stands, the word over it: in progress while its agent is at work
 * or asleep (`chatThreadStateSchema`); waiting for the person, its agent stopped needing them to
 * answer or act before it can go on; or done, needing nothing of them. A small model reads which
 * as the thread's turn ends; without one, or where it can't, the thread is done.
 * `POST chat/personas/:personaId/threads/:threadId/done`, with no body: the person says a thread
 * waiting for them is done.
 */
export const threadStandingSchema = z.enum(['in_progress', 'waiting', 'done']);

export type ThreadStanding = z.infer<typeof threadStandingSchema>;

/**
 * Something said in a thread, as its page shows it: what the person said, with the files they
 * attached to it; what the persona answered, or told them as it went, with the files its words
 * show, which is what went wrong where its turn failed; or an event, an alert set in the thread
 * that came. What the persona did to get there is in the activity log, not here.
 */
export const threadMessageSchema = z.object({
	id: z.string(),
	kind: z.enum(['person', 'assistant', 'event']),
	text: z.string(),
	isError: z.boolean(),
	at: z.string(),
	attachments: z.array(chatAttachmentSchema),
});

export type ThreadMessage = z.infer<typeof threadMessageSchema>;

/**
 * One of the chat's threads, as the chat lists it: its title; what it is up to, and where it
 * stands (`threadStandingSchema`); what opened it, the person's message with the files they
 * attached, or an event's text; where it stands in one sentence, as written when its turn last
 * ended, null before one was, where none could be, and once anything was said in it since, until
 * the next is; the start of the latest
 * thing the persona said in it, cut to a line, null before it said anything, and the entry that
 * came from, an answer or one whose step told the person something as it went; the persona's
 * latest answer in words in it, the kind `GET chat/answers` reports and
 * `POST chat/personas/:personaId/read` takes, null before it answered; how many messages it holds
 * (`threadMessageSchema`), and when the last came.
 */
export const chatThreadSchema = z.object({
	id: z.string(),
	title: z.string(),
	state: chatThreadStateSchema,
	standing: threadStandingSchema,
	opener: z
		.discriminatedUnion('kind', [
			z.object({
				kind: z.literal('person'),
				text: z.string(),
				attachments: z.array(chatAttachmentSchema),
			}),
			z.object({kind: z.literal('event'), text: z.string()}),
		])
		.nullable(),
	summary: z.string().nullable(),
	latest: z.string().nullable(),
	latestEntryId: z.string().nullable(),
	latestAnswerId: z.string().nullable(),
	messageCount: z.number(),
	lastMessageAt: z.string(),
});

export type ChatThread = z.infer<typeof chatThreadSchema>;

/**
 * `GET chat/personas/:personaId/threads`: the person's chat with a persona, begun where there was
 * none: the persona, and its threads, the one that last had a message last.
 */
export const chatThreadsSchema = z.object({
	persona: chatPersonaSchema,
	/** What the person typed in it and hasn't sent (`PUT chat/personas/:personaId/draft`); null without one. */
	draft: z.string().nullable(),
	/**
	 * The files the person put in its input and hasn't sent, in the order they were put there
	 * (`POST` and `DELETE chat/personas/:personaId/attachments`), kept as the draft is.
	 */
	draftAttachments: z.array(chatAttachmentSchema),
	threads: z.array(chatThreadSchema),
});

export type ChatThreads = z.infer<typeof chatThreadsSchema>;

/**
 * `GET chat/personas/:personaId/threads/:threadId`: one of the chat's threads: the persona, the
 * thread, whether it is at work, as against asleep or done for now, and what was said in it, in
 * order.
 */
export const threadViewSchema = z.object({
	persona: chatPersonaSchema,
	thread: chatThreadSchema,
	busy: z.boolean(),
	messages: z.array(threadMessageSchema),
});

export type ThreadView = z.infer<typeof threadViewSchema>;

/**
 * `POST chat/personas/:personaId/threads`, with a body as `postMessageBodySchema`: a thread opened
 * in the chat with what the person says, and the files they attach, as its first message; the
 * chat's draft goes with it, since this is it sent. Its persona is woken in it.
 */
export const openedThreadSchema = z.object({thread: chatThreadSchema});

/**
 * `POST chat/personas/:personaId/threads/:threadId/messages`, with a body as
 * `postMessageBodySchema`: what the person replies in a thread, which takes it up again.
 * `POST chat/personas/:personaId/threads/:threadId/attachments?name=&type=`: a file for a reply
 * (`uploadAttachmentQuerySchema`).
 */
export const postedReplySchema = z.object({message: threadMessageSchema});
