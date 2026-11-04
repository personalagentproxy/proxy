import {inspectionSchema, modelRequestSchema} from '@proxy/contracts/inspect';
import {apiRequest, orgApi} from '@/client/request';

// The inspector's api (@proxy/contracts/inspect): the person's conversation with a persona as the
// harness has it, and, for an answer of the model, the request it was sent.

export function getInspection(org: string, personaId: string) {
	return apiRequest('GET', `${orgApi(org)}/chat/personas/${personaId}/inspect`, inspectionSchema);
}

export function getRequest(org: string, entryId: string) {
	return apiRequest(
		'GET',
		`${orgApi(org)}/chat/inspect/entries/${entryId}/request`,
		modelRequestSchema,
	);
}
