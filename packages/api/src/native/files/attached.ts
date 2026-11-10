import {Ok} from 'ts-results-es';

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
	// Read here rather than as the module loads, as the drive's connection is made
	// (connections.ts): the gate's tests mock each database module they reach.
	const {isAttachedForTask} = await import('@proxy/db/harness');
	return isAttachedForTask({orgId: caller.agent.orgId, taskId: caller.taskId}, {connectionId: connection.id, fileId: id, version});
};
