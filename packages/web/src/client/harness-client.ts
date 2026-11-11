import {
	chatAnswersSchema,
	type markReadBodySchema,
	personaAnswerSchema,
	personaListSchema,
	type Persona,
	type pinTaskBodySchema,
	type postMessageBodySchema,
	postedMessageSchema,
	type saveDraftBodySchema,
	taskChatSchema,
	threadLogSchema,
} from '@proxy/contracts/harness';
import type {z} from 'zod';
import {apiRequest, apiSend, orgApi} from '@/client/request';

// The Chat page's api: the organization's personas, each named and given a head, which every
// member sees, the person's own conversation with each, its turns, what they say in it, and how
// far they have read it, and the tasks the persona started in it, each with a chat of its own.

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

// A task the persona started in the person's conversation with it, as its chat shows it.
export function getTask(org: string, personaId: string, taskId: string) {
	return apiRequest(
		'GET',
		`${orgApi(org)}/chat/personas/${personaId}/tasks/${taskId}`,
		taskChatSchema,
	);
}

// What the person writes to a task in its chat: the task takes it up; the persona is told.
export function postTaskMessage(org: string, personaId: string, taskId: string, text: string) {
	return apiSend('POST', `${orgApi(org)}/chat/personas/${personaId}/tasks/${taskId}/messages`, {
		text,
	} satisfies z.input<typeof postMessageBodySchema>);
}

// Pins a task of the person's conversation with the persona to the list under it, or unpins it.
export function pinTask(org: string, personaId: string, taskId: string, pinned: boolean) {
	return apiSend('PUT', `${orgApi(org)}/chat/personas/${personaId}/tasks/${taskId}/pin`, {
		pinned,
	} satisfies z.input<typeof pinTaskBodySchema>);
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
