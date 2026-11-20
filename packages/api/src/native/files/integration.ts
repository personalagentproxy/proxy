import type {ApiIntegration} from '../../connections/integration';
import {uploadActions, uploadTools} from '../../uploads/tools';
import {readsAttached} from './attached';
import {filesCliDrive} from './cli-drive';
import {filesConnector} from './connector';
import {filesUploads} from './uploads';
import {runFilesCreate, runFilesMove, runFilesRead, runFilesRestore, runFilesTrash, runFilesUntrash, runFilesVersions, runFilesWrite} from './tools';

/** Files, in Personal Agent Proxy itself: a drive's tree as records, read, and every write and every read of a version as tools of its own, uploads through a URL among them; a version the person attached in a thread is read by its agent whatever its access; and its files by path from a sandbox (`pap files`, cli-drive.ts). */
export const FILES_INTEGRATION: ApiIntegration = {
	id: 'files',
	connectors: {files: filesConnector},
	tools: {
		files_create: runFilesCreate,
		files_write: runFilesWrite,
		files_read: runFilesRead,
		files_versions: runFilesVersions,
		files_restore: runFilesRestore,
		files_move: runFilesMove,
		files_trash: runFilesTrash,
		files_untrash: runFilesUntrash,
		...uploadTools(filesUploads),
	},
	allowances: {files_read: readsAttached},
	actions: uploadActions,
	uploads: filesUploads,
	cli: filesCliDrive,
};
