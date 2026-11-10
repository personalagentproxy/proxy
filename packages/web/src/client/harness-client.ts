import {
	type ChatAttachment,
	chatAnswersSchema,
	type markReadBodySchema,
	personaAnswerSchema,
	personaListSchema,
	type Persona,
	type postMessageBodySchema,
	postedMessageSchema,
	type saveDraftBodySchema,
	threadLogSchema,
	uploadedAttachmentSchema,
} from '@proxy/contracts/harness';
import {httpRequest} from '@proxy/utils';
import type {z} from 'zod';
import {apiRequest, apiSend, orgApi} from '@/client/request';
import {trackWrite} from '@/lib/writes-in-flight';

// The Chat page's api: the organization's personas, each named and given a head, which every
// member sees, the person's own conversation with each, its turns, what they say in it, and how
// far they have read it.

export function listPersonas(org: string) {
	return apiRequest('GET', `${orgApi(org)}/chat/personas`, personaListSchema);
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

export function getThread(org: string, personaId: string) {
	return apiRequest('GET', `${orgApi(org)}/chat/personas/${personaId}/thread`, threadLogSchema);
}

export function postMessage(
	org: string,
	personaId: string,
	text: string,
	attachments: ChatAttachment[] = [],
) {
	return apiRequest(
		'POST',
		`${orgApi(org)}/chat/personas/${personaId}/messages`,
		postedMessageSchema,
		{
			text,
			attachments: attachments.map(({connectionId, fileId, version}) => ({
				connectionId,
				fileId,
				version,
			})),
		} satisfies z.input<typeof postMessageBodySchema>,
	);
}

/**
 * Uploads a file from the conversation's input, which the api keeps in the person's own drive:
 * what to attach to the next message. The file is the request's body, sent as bytes whatever it
 * holds, its own type beside its name in the address.
 */
export function uploadAttachment(org: string, personaId: string, file: File) {
	const params = new URLSearchParams({name: file.name, ...(file.type ? {type: file.type} : {})});
	return trackWrite(
		httpRequest(
			`${orgApi(org)}/chat/personas/${personaId}/attachments?${params.toString()}`,
			{method: 'POST', headers: {'Content-Type': 'application/octet-stream'}, body: file},
			{schema: uploadedAttachmentSchema},
		),
	);
}

export function markRead(org: string, personaId: string, entryId: string) {
	return apiSend('POST', `${orgApi(org)}/chat/personas/${personaId}/read`, {
		entryId,
	} satisfies z.input<typeof markReadBodySchema>);
}

// What the person has typed to the persona and not sent, kept in place of what was; an empty one
// forgets it.
export function saveDraft(
	org: string,
	personaId: string,
	text: string,
	options: {keepalive?: boolean} = {},
) {
	return apiSend(
		'PUT',
		`${orgApi(org)}/chat/personas/${personaId}/draft`,
		{text} satisfies z.input<typeof saveDraftBodySchema>,
		options,
	);
}
