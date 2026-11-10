import {
	chatAnswersSchema,
	type markReadBodySchema,
	personaAnswerSchema,
	personaListSchema,
	type Persona,
	type postMessageBodySchema,
	postedMessageSchema,
	type saveDraftBodySchema,
	threadLogSchema,
} from '@proxy/contracts/harness';
import type {z} from 'zod';
import {apiRequest, apiSend, orgApi} from '@/client/request';

// The Chat page's api: the personas the person sees, their own and General, which every member
// does, each named and given a head, the person's own conversation with each, its turns, what they say in it, and how
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

export function postMessage(org: string, personaId: string, text: string) {
	return apiRequest(
		'POST',
		`${orgApi(org)}/chat/personas/${personaId}/messages`,
		postedMessageSchema,
		{text} satisfies z.input<typeof postMessageBodySchema>,
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
