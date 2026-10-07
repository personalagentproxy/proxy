import {z} from 'zod';
import {dataRecordSchema} from '@/client/schemas';
import {apiRequest, apiSend} from '@/client/request';

// The human side's records: in full, and not logged. Only Information's are shown for now.

function recordsPath(connectionId: string, collectionId: string): string {
	return `/api/connections/${connectionId}/collections/${collectionId}/records`;
}

export function listRecords(connectionId: string, collectionId: string) {
	return apiRequest(
		'GET',
		recordsPath(connectionId, collectionId),
		z.object({records: z.array(dataRecordSchema), nextPage: z.string().nullable()}),
	);
}

export function createRecord(
	connectionId: string,
	collectionId: string,
	values: Record<string, string>,
) {
	return apiRequest('POST', recordsPath(connectionId, collectionId), dataRecordSchema, {values});
}

export function updateRecord(
	connectionId: string,
	collectionId: string,
	recordId: string,
	values: Record<string, string>,
) {
	return apiRequest(
		'PUT',
		`${recordsPath(connectionId, collectionId)}/${recordId}`,
		dataRecordSchema,
		{values},
	);
}

export function deleteRecord(connectionId: string, collectionId: string, recordId: string) {
	return apiSend('DELETE', `${recordsPath(connectionId, collectionId)}/${recordId}`);
}
