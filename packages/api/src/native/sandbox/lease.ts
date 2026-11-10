import {Err, type Result} from 'ts-results-es';

import {ApiErr, type ApiError, Do} from '@proxy/utils';
import {taskEndedAt} from '@proxy/utils/tasks';
import {getHoldingTask, holdSandbox, type SandboxRow} from '@proxy/db/sandbox';

/**
 * A sandbox is one task's at a time: taken by the first call a task makes on it, kept while that
 * task is under way, and free again once it is finished or left open (@proxy/utils/tasks), so two
 * agents never work on one at once, while coming back to it later is the rule. A sub-task of the
 * task holding it, at any depth, works on it as that task does. A call on a sandbox another task
 * holds is refused with the task named, so the agent can make one of its own or wait.
 */

// How far up a task's parents are followed for the one holding the sandbox.
const MAX_DEPTH = 8;

// Whether `taskId` is the holder, or a sub-task of it at any depth.
function underHolder(orgId: string, taskId: string, holderId: string): Promise<Result<boolean, ApiError>> {
	return Do(async ($) => {
		let current: string | null = taskId;
		for (let depth = 0; current !== null && depth < MAX_DEPTH; depth++) {
			if (current === holderId) {
				return true;
			}
			const task: {parentId: string | null} | null = $(await getHoldingTask(orgId, current));
			current = task?.parentId ?? null;
		}
		return false;
	});
}

/** Takes the sandbox for the task, or refuses it, naming the task that has it. */
export function holdForTask(sandbox: SandboxRow, taskId: string, now = new Date()): Promise<Result<void, ApiError>> {
	return Do(async ($) => {
		if (sandbox.heldByTaskId === taskId) {
			return;
		}
		if (sandbox.heldByTaskId === null) {
			if ($(await holdSandbox(sandbox.id, taskId, null))) {
				return;
			}
			return $(Err(ApiErr.conflict(`The sandbox “${sandbox.name}” was just taken by another task. Make a sandbox of your own, or try again in a moment.`)));
		}
		const holder = $(await getHoldingTask(sandbox.orgId, sandbox.heldByTaskId));
		if (holder && taskEndedAt(holder, now) === null) {
			if ($(await underHolder(sandbox.orgId, taskId, holder.id))) {
				return;
			}
			return $(Err(ApiErr.conflict(`The sandbox “${sandbox.name}” is in use by the task “${holder.title}”. Make a sandbox of your own, or come back once that task is done.`)));
		}
		// The task that had it is done or gone: this one takes over, unless another did just now.
		if ($(await holdSandbox(sandbox.id, taskId, sandbox.heldByTaskId))) {
			return;
		}
		return $(Err(ApiErr.conflict(`The sandbox “${sandbox.name}” was just taken by another task. Make a sandbox of your own, or try again in a moment.`)));
	});
}

/** Whether the task holding the sandbox is still under way, and which it is, for the list. */
export function holderOf(sandbox: SandboxRow, now = new Date()): Promise<Result<{id: string; title: string} | null, ApiError>> {
	return Do(async ($) => {
		if (sandbox.heldByTaskId === null) {
			return null;
		}
		const holder = $(await getHoldingTask(sandbox.orgId, sandbox.heldByTaskId));
		if (!holder || taskEndedAt(holder, now) !== null) {
			return null;
		}
		return {id: holder.id, title: holder.title};
	});
}
