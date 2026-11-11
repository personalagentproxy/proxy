import {Err, Ok, type Result} from 'ts-results-es';

import {ApiErr, type ApiError, Do, requirePresent} from '@proxy/utils';
import {type FileFound, getFile} from '@proxy/db/files';
import {isAttachedForTask} from '@proxy/db/harness';

import type {TaskCaller} from '../../agent-side/tools';
import type {NativeToolAllowance} from '../tool';

/**
 * What attaching a file hands over: a person who attaches a file to their conversation with an
 * agent means it to be read there, so the conversation's agents may read that version of it with
 * `files_read`, by its id and the version attached, whatever they may do in its drive otherwise.
 * Nothing more: not the file as it is later, nor anything beside it, which take the access the
 * drive gives. Asked by the gate where the agent may not read the drive (native/tool.ts), for the
 * task the read is run for: a sub-agent's, of the conversation the file was attached in.
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
 * for the version of it attached to the caller's conversation, which stays readable there as the
 * conversation still shows it.
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
