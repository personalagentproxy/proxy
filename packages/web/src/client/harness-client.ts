import {
	personaAnswerSchema,
	personaListSchema,
	type Persona,
	type postMessageBodySchema,
	postedMessageSchema,
	threadLogSchema,
} from '@proxy/contracts/harness';
import type {z} from 'zod';
import {apiRequest, apiSend, orgApi} from '@/client/request';

// The Chat page's api: the organization's personas, each named and given a head, which every
// member sees, the person's own conversation with each, its turns, and what they say in it.

export function listPersonas(org: string) {
	return apiRequest('GET', `${orgApi(org)}/chat/personas`, personaListSchema);
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
