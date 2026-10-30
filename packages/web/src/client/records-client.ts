import {dataRecordSchema, recordPageSchema} from '@proxy/contracts/records';
import {apiRequest, apiSend, orgApi} from '@/client/request';

// The human side's records: in full, and not logged. Only the vault's are shown for now. Every
// call is about one organization, by its slug (`org`).

function recordsPath(org: string, connectionId: string, collectionId: string): string {
	return `${orgApi(org)}/connections/${connectionId}/collections/${collectionId}/records`;
}

export function listRecords(org: string, connectionId: string, collectionId: string) {
	return apiRequest('GET', recordsPath(org, connectionId, collectionId), recordPageSchema);
}

export function getRecord(
	org: string,
	connectionId: string,
	collectionId: string,
	recordId: string,
) {
	return apiRequest(
		'GET',
		`${recordsPath(org, connectionId, collectionId)}/${encodeURIComponent(recordId)}`,
		dataRecordSchema,
	);
}

export function createRecord(
	org: string,
	connectionId: string,
	collectionId: string,
	values: Record<string, string>,
) {
	return apiRequest('POST', recordsPath(org, connectionId, collectionId), dataRecordSchema, {
		values,
	});
}

export function updateRecord(
	org: string,
	connectionId: string,
	collectionId: string,
	recordId: string,
	values: Record<string, string>,
) {
	return apiRequest(
		'PUT',
		`${recordsPath(org, connectionId, collectionId)}/${recordId}`,
		dataRecordSchema,
		{values},
	);
}

export function deleteRecord(
	org: string,
	connectionId: string,
	collectionId: string,
	recordId: string,
) {
	return apiSend('DELETE', `${recordsPath(org, connectionId, collectionId)}/${recordId}`);
}
