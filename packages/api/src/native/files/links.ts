import {env} from '../../utils/env';

/**
 * A file's or a folder's address in the web app, the page the person opens it on: its drive's
 * page, at the folder it is in, with a file shown. What an agent hands the person to point at a
 * file, since a file kept here has no address anywhere else; read back where an answer shows the
 * file as a picture (@proxy/utils/file-links).
 */
export function fileLink(orgSlug: string, connectionId: string, file: {id: string; parentId: string | null; folder: boolean}): string {
	const base = `${env.APP_URL}/${orgSlug}/connections/${connectionId}`;
	if (file.folder) {
		return `${base}?folder=${file.id}`;
	}
	const folder = file.parentId === null ? '' : `folder=${file.parentId}&`;
	return `${base}?${folder}file=${file.id}`;
}
