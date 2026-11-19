import {driveFileHistorySchema, driveHistoryListSchema} from '@proxy/contracts/drive-history';
import {apiRequest, apiSend, orgApi} from '@/client/request';

// A Google connection's history of its files in Drive, on its connection's page: the files changed
// through Personal Agent Proxy, a file's versions and changes, and giving a version back or undoing
// a change, as the person's own.

function historyPath(org: string, connectionId: string): string {
	return `${orgApi(org)}/connections/${connectionId}/drive-history`;
}

export function listDriveHistory(org: string, connectionId: string) {
	return apiRequest('GET', historyPath(org, connectionId), driveHistoryListSchema);
}

export function getDriveFileHistory(org: string, connectionId: string, fileId: string) {
	return apiRequest(
		'GET',
		`${historyPath(org, connectionId)}/${encodeURIComponent(fileId)}`,
		driveFileHistorySchema,
	);
}

/** Gives a version back as the file's newest revision in Drive. */
export function restoreDriveVersion(
	org: string,
	connectionId: string,
	fileId: string,
	version: string,
) {
	return apiSend(
		'POST',
		`${historyPath(org, connectionId)}/${encodeURIComponent(fileId)}/restore`,
		{
			version,
		},
	);
}

/** Puts back what a change with an exact undo wrote over. */
export function undoDriveChange(org: string, connectionId: string, fileId: string, change: string) {
	return apiSend(
		'POST',
		`${historyPath(org, connectionId)}/${encodeURIComponent(fileId)}/changes/${encodeURIComponent(change)}/undo`,
	);
}
