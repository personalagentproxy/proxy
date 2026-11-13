import {
	type ChatAttachment,
	chatAnswersSchema,
	chatThreadsSchema,
	type markReadBodySchema,
	openedThreadSchema,
	personaAnswerSchema,
	personaListSchema,
	type Persona,
	type postMessageBodySchema,
	postedReplySchema,
	type removeAttachmentBodySchema,
	type saveDraftBodySchema,
	threadViewSchema,
	uploadedAttachmentSchema,
} from '@proxy/contracts/harness';
import type {z} from 'zod';
import {apiRequest, apiSend, apiUpload, orgApi} from '@/client/request';
import {rememberPersonaList} from '@/lib/persona-list';

// The Chat page's api: the personas the person sees, their own and General, which every member
// does, each named and given a head, and the person's own chat with each: its threads, each
// opened by what they said in the chat and read on its own, what they reply in one, what they
// typed in the chat and haven't sent, and how far they have read it.

// How long a list asked for ahead of Chat's opening is fresh enough not to ask again.
const PREFETCH_GAP_MS = 10 * 1000;
const prefetchedAt = new Map<string, number>();

/** Asks for the list ahead of Chat's opening, as the pointer heads for it, to remember it. */
export function prefetchPersonaList(org: string): void {
	const now = Date.now();
	if (now - (prefetchedAt.get(org) ?? 0) < PREFETCH_GAP_MS) {
		return;
	}
	prefetchedAt.set(org, now);
	void listPersonas(org);
}

/** The list, remembered as it comes (lib/persona-list.ts). */
export async function listPersonas(org: string) {
	const listed = await apiRequest('GET', `${orgApi(org)}/chat/personas`, personaListSchema);
	if (listed.isOk()) {
		rememberPersonaList(org, listed.value);
	}
	return listed;
}

export function listAnswers(org: string) {
	return apiRequest('GET', `${orgApi(org)}/chat/answers`, chatAnswersSchema);
}

export function createPersona(org: string, persona: Persona) {
	return apiRequest('POST', `${orgApi(org)}/chat/personas`, personaAnswerSchema, persona);
}

export function updatePersona(org: string, personaId: string, persona: Persona) {
	return apiRequest(
		'PUT',
		`${orgApi(org)}/chat/personas/${personaId}`,
		personaAnswerSchema,
		persona,
	);
}

export function deletePersona(org: string, personaId: string) {
	return apiSend('DELETE', `${orgApi(org)}/chat/personas/${personaId}`);
}

export function listThreads(org: string, personaId: string) {
	return apiRequest('GET', `${orgApi(org)}/chat/personas/${personaId}/threads`, chatThreadsSchema);
}

export function getChatThread(org: string, personaId: string, threadId: string) {
	return apiRequest(
		'GET',
		`${orgApi(org)}/chat/personas/${personaId}/threads/${threadId}`,
		threadViewSchema,
	);
}

// What the person says, with the files they attach to it, each where it sits among the words, as
// the api takes it.
function messageBody(
	text: string,
	attachments: ChatAttachment[],
): z.input<typeof postMessageBodySchema> {
	return {
		text,
		attachments: attachments.map(({connectionId, fileId, version}) => ({
			connectionId,
			fileId,
			version,
		})),
	};
}

/** Opens a thread in the person's chat with the persona with what they say: the chat's draft goes with it. */
export function openThread(
	org: string,
	personaId: string,
	text: string,
	attachments: ChatAttachment[] = [],
) {
	return apiRequest(
		'POST',
		`${orgApi(org)}/chat/personas/${personaId}/threads`,
		openedThreadSchema,
		messageBody(text, attachments),
	);
}

/** What the person replies in one of the chat's threads, which takes it up again. */
export function replyInThread(
	org: string,
	personaId: string,
	threadId: string,
	text: string,
	attachments: ChatAttachment[],
) {
	return apiRequest(
		'POST',
		`${orgApi(org)}/chat/personas/${personaId}/threads/${threadId}/messages`,
		postedReplySchema,
		messageBody(text, attachments),
	);
}

/** Uploads a file put in a thread's input to the person's own drive: what to attach to what they reply next, which the page holds until then. */
export function uploadThreadAttachment(
	org: string,
	personaId: string,
	threadId: string,
	file: File,
) {
	return apiUpload(
		'POST',
		`${orgApi(org)}/chat/personas/${personaId}/threads/${threadId}/attachments`,
		{name: file.name},
		file,
		uploadedAttachmentSchema,
	);
}

/**
 * Uploads a file put in the conversation's input, which the api keeps in the person's own drive
 * and in the input, until the next message is sent: what to attach to it. The file is the request's body, sent as bytes whatever it
 * holds, its own type beside its name in the address.
 */
export function uploadAttachment(org: string, personaId: string, file: File) {
	return apiUpload(
		'POST',
		`${orgApi(org)}/chat/personas/${personaId}/attachments`,
		{name: file.name},
		file,
		uploadedAttachmentSchema,
	);
}

/** Takes a file out of the conversation's input, where the api keeps it until the next message is sent; the file stays in its drive. */
export function removeAttachment(org: string, personaId: string, attachment: ChatAttachment) {
	const {connectionId, fileId, version} = attachment;
	return apiSend('DELETE', `${orgApi(org)}/chat/personas/${personaId}/attachments`, {
		connectionId,
		fileId,
		version,
	} satisfies z.input<typeof removeAttachmentBodySchema>);
}

export function markRead(org: string, personaId: string, entryId: string) {
	return apiSend('POST', `${orgApi(org)}/chat/personas/${personaId}/read`, {
		entryId,
	} satisfies z.input<typeof markReadBodySchema>);
}

// What the person has typed to the persona and not sent, kept in place of what was; an empty one
// forgets it.
/**
 * Saves what is typed and not sent. With `files`, the files that sit among the words, in the
 * order of their marks in the text: the api keeps the input's files in that order.
 */
export function saveDraft(
	org: string,
	personaId: string,
	text: string,
	options: {keepalive?: boolean; files?: ChatAttachment[]} = {},
) {
	const {files, ...sending} = options;
	return apiSend(
		'PUT',
		`${orgApi(org)}/chat/personas/${personaId}/draft`,
		{
			text,
			...(files === undefined || files.length === 0
				? {}
				: {
						attachments: files.map(({connectionId, fileId, version}) => ({
							connectionId,
							fileId,
							version,
						})),
					}),
		} satisfies z.input<typeof saveDraftBodySchema>,
		sending,
	);
}
