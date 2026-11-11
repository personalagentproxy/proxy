import type {ApiIntegration} from '../../connections/integration';
import {readsAttached} from './attached';
import {filesConnector} from './connector';
import {runFilesCreate, runFilesMove, runFilesRead, runFilesRestore, runFilesTrash, runFilesUntrash, runFilesVersions, runFilesWrite} from './tools';

/** Files, in Personal Agent Proxy itself: a drive's tree as records, read, and every write and every read of a version as tools of its own; a version the person attached to a conversation is read by its agents whatever their access. */
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
	},
	allowances: {files_read: readsAttached},
};
