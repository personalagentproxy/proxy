import {Err, Ok, type Result} from 'ts-results-es';

import {ApiErr, type ApiError, Do, requirePresent} from '@proxy/utils';
import {type FileFound, getFile} from '@proxy/db/files';
import {isAttachedForTask} from '@proxy/db/harness';

import type {TaskCaller} from '../../agent-side/tools';
import type {NativeToolAllowance} from '../tool';

/**
 * What attaching a file hands over: a person who attaches a file to what they say in a thread of
 * their chat with an agent means it to be read there, so the thread's agent may read that version
 * of it with `files_read`, by its id and the version attached, whatever it may do in its drive
 * otherwise. Nothing more: not the file as it is later, nor anything beside it, which take the
 * access the drive gives. Asked by the gate where the agent may not read the drive
 * (native/tool.ts), for the task the read is run for: the task of the thread the file was attached
 * in.
 */
export const readsAttached: NativeToolAllowance = async ({caller, connection, params}) => {
	const {id, version} = params;
	if (typeof id !== 'string' || typeof version !== 'string') {
		return Ok(false);
	}
	return isAttachedForTask({orgId: caller.agent.orgId, taskId: caller.taskId}, {connectionId: connection.id, fileId: id, version});
};

/**
 * The file a read names, by `files_read` or `pap files pull`: one in the trash is not found, but
 * for the version of it attached in the caller's thread, which stays readable there while the file
 * is in the trash. Once the trash is emptied of it, it is gone, and the thread says so
 * (@proxy/db/harness listAttachments).
 */
export function requireReadFile(caller: TaskCaller, connectionId: string, id: string, version: string | undefined): Promise<Result<FileFound, ApiError>> {
	return Do(async ($) => {
		const found = $(requirePresent($(await getFile(connectionId, id)), ApiErr.notFound('file', id)));
		if (!found.trashed) {
			return found;
		}
		if (version !== undefined && $(await isAttachedForTask({orgId: caller.agent.orgId, taskId: caller.taskId}, {connectionId, fileId: id, version}))) {
			return found;
		}
		return $(Err(ApiErr.notFound('file', id, 'It is in the trash.')));
	});
}
