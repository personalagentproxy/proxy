import {fileAnswerSchema, fileDetailSchema, fileListSchema} from '@proxy/contracts/files';
import {apiRequest, apiSend, apiUpload, orgApi} from '@/client/request';

// A drive's files, on its connection's page: its folders and the trash, a file with its versions,
// and what the person does to one. A file's bytes go up as the request's body, as they are, and
// come down from an address a link or a picture points at (`fileContentPath`).

function filesPath(org: string, connectionId: string): string {
	return `${orgApi(org)}/connections/${connectionId}/files`;
}

/** What a folder holds, the top's for null; or, with `search`, what has it in its name, there and below. */
export function listFiles(
	org: string,
	connectionId: string,
	parent: string | null,
	search: string | null = null,
) {
	const params = new URLSearchParams({
		...(parent === null ? {} : {parent}),
		...(search === null ? {} : {search}),
	});
	const query = params.size === 0 ? '' : `?${params.toString()}`;
	return apiRequest('GET', `${filesPath(org, connectionId)}${query}`, fileListSchema);
}

export function listTrashedFiles(org: string, connectionId: string) {
	return apiRequest('GET', `${filesPath(org, connectionId)}/trash`, fileListSchema);
}

export function getFile(org: string, connectionId: string, fileId: string) {
	return apiRequest(
		'GET',
		`${filesPath(org, connectionId)}/${encodeURIComponent(fileId)}`,
		fileDetailSchema,
	);
}

export function createFolder(
	org: string,
	connectionId: string,
	name: string,
	parent: string | null,
) {
	return apiRequest('POST', `${filesPath(org, connectionId)}/folders`, fileAnswerSchema, {
		name,
		parent,
	});
}

/** Uploads a new file into `parent`, called a free name like its own where that is taken. */
export function uploadFile(org: string, connectionId: string, file: File, parent: string | null) {
	return apiUpload(
		'POST',
		`${filesPath(org, connectionId)}/uploads`,
		{name: file.name, ...(parent === null ? {} : {parent})},
		file,
		fileAnswerSchema,
	);
}

/** Uploads a file's next version, over the one the page showed (`version`). */
export function uploadFileVersion(
	org: string,
	connectionId: string,
	fileId: string,
	version: string,
	file: File,
) {
	return apiUpload(
		'PUT',
		`${filesPath(org, connectionId)}/${fileId}/content`,
		{version},
		file,
		fileAnswerSchema,
	);
}

/** Moves a file or a folder into `parent`, the top of the drive for null. */
export function moveFile(org: string, connectionId: string, fileId: string, parent: string | null) {
	return apiRequest('PATCH', `${filesPath(org, connectionId)}/${fileId}`, fileAnswerSchema, {
		parent,
	});
}

export function renameFile(org: string, connectionId: string, fileId: string, name: string) {
	return apiRequest('PATCH', `${filesPath(org, connectionId)}/${fileId}`, fileAnswerSchema, {name});
}

export function trashFile(org: string, connectionId: string, fileId: string) {
	return apiSend('POST', `${filesPath(org, connectionId)}/${fileId}/trash`);
}

export function untrashFile(org: string, connectionId: string, fileId: string) {
	return apiRequest('POST', `${filesPath(org, connectionId)}/${fileId}/untrash`, fileAnswerSchema);
}

export function restoreFileVersion(
	org: string,
	connectionId: string,
	fileId: string,
	version: string,
) {
	return apiRequest('POST', `${filesPath(org, connectionId)}/${fileId}/restore`, fileAnswerSchema, {
		version,
	});
}

/** Where a file's bytes are: what it holds now, or one of its versions. A link there saves it; a picture shows. */
export function fileContentPath(
	org: string,
	connectionId: string,
	fileId: string,
	version?: string,
): string {
	const query = version === undefined ? '' : `?version=${encodeURIComponent(version)}`;
	return `${filesPath(org, connectionId)}/${fileId}/content${query}`;
}
