import {randomBytes} from 'node:crypto';

import {Err, type Result} from 'ts-results-es';

import {ApiErr, type ApiError, Do, requirePresent} from '@proxy/utils';
import {getSandbox, listSandboxes, type SandboxRow} from '@proxy/db/sandbox';

import {type DataRecord, type RecordStore, type RecordTarget, requireFirstPage} from '../../records/connector';
import {holderOf} from './lease';
import {destroySandbox, makeSandbox, sleepSandbox, wakeSandbox} from './machines';

/**
 * The sandboxes of a Sandboxes connection as records: listed and opened with what each is up to,
 * made with a name, put to sleep, woken and deleted. The console is the integration's own tool
 * (exec.ts), whose first command on a sandbox takes it for the task (lease.ts); one just made is
 * nobody's until then.
 */

function stateOf(sandbox: SandboxRow): string {
	return sandbox.state === 'running' ? 'Running' : 'Asleep';
}

// A sandbox as a record: its name, state, the task using it where one is, and when it was last used.
function toRecord(sandbox: SandboxRow): Promise<Result<DataRecord, ApiError>> {
	return Do(async ($) => {
		const holder = $(await holderOf(sandbox));
		return {
			id: sandbox.id,
			values: {name: sandbox.name, state: stateOf(sandbox), heldBy: holder?.title ?? '', lastUsedAt: sandbox.lastUsedAt.toISOString()},
			updatedAt: sandbox.lastUsedAt.toISOString(),
		};
	});
}

function requireSandbox(target: RecordTarget, sandboxId: string): Promise<Result<SandboxRow, ApiError>> {
	return Do(async ($) => {
		return $(requirePresent($(await getSandbox(target.connection.id, sandboxId)), ApiErr.notFound('record', sandboxId)));
	});
}

/** The sandboxes collection's connector: the rows, with the backend asked to make, wake, sleep and destroy. */
export const sandboxConnector = {
	// Few enough to list on one page, newest first.
	list: (target, query) =>
		Do(async ($) => {
			$(requireFirstPage(query));
			const rows = $(await listSandboxes(target.connection.id));
			const search = query.search?.trim().toLowerCase();
			const records: DataRecord[] = [];
			for (const row of rows) {
				const record = $(await toRecord(row));
				if (!search || record.values.name?.toLowerCase().includes(search)) {
					records.push(record);
				}
			}
			return {records, nextPage: null};
		}),
	get: (target, recordId) =>
		Do(async ($) => {
			return $(await toRecord($(await requireSandbox(target, recordId))));
		}),
	create: (target, values) =>
		Do(async ($) => {
			const name = (values.name ?? '').trim();
			if (name === '') {
				return $(Err(ApiErr.validationError('A sandbox needs a name: what it is for, in a few words')));
			}
			const made = $(
				await makeSandbox({
					id: randomBytes(10).toString('hex'),
					orgId: target.connection.orgId,
					connectionId: target.connection.id,
					name,
				}),
			);
			return $(await toRecord(made));
		}),
	remove: (target, recordId) =>
		Do(async ($) => {
			$(await destroySandbox($(await requireSandbox(target, recordId))));
		}),
	commands: {
		sleep: (target, recordId) =>
			Do(async ($) => {
				return $(await toRecord($(await sleepSandbox($(await requireSandbox(target, recordId))))));
			}),
		wake: (target, recordId) =>
			Do(async ($) => {
				return $(await toRecord($(await wakeSandbox($(await requireSandbox(target, recordId))))));
			}),
	},
} satisfies RecordStore;
