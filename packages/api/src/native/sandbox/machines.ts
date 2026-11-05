import {Err, Ok, type Result} from 'ts-results-es';

import {ApiErr, type ApiError, Do, requirePresent} from '@proxy/utils';
import type {SandboxBackend} from '@proxy/backends/sandbox/backend';
import {createSandbox, deleteSandbox, getSandbox, moveSandbox, type SandboxRow} from '@proxy/db/sandbox';

import {sandboxBackend} from '../../backends/backends';

/**
 * A sandbox's machine, as the backend runs it and the row records it: made, woken, put to sleep
 * and destroyed here, each a move of the row fenced on the state it leaves, so of two calls moving
 * one sandbox at once only the first asks the backend. The backend's ref is kept as it hands it
 * back, since it may change on sleep and wake. A sandbox made by one backend is never handed to
 * another: the server's backend changed, it is left as it is, asleep for good.
 */

const NOT_SET_UP = 'Sandboxes are not set up on this server: there is no sandbox backend.';

/** The server's sandbox backend, or unavailable. */
export async function requireBackend(): Promise<Result<SandboxBackend, ApiError>> {
	const backend = await sandboxBackend();
	if (backend === null) {
		return Err(ApiErr.unavailable(NOT_SET_UP));
	}
	return Ok(backend);
}

// The backend that made the sandbox, which is this server's or none.
async function backendOf(sandbox: SandboxRow): Promise<Result<SandboxBackend, ApiError>> {
	const backend = await requireBackend();
	if (backend.isErr()) {
		return backend;
	}
	if (backend.value.id !== sandbox.backendId) {
		return Err(ApiErr.unavailable(`The sandbox “${sandbox.name}” was made by another sandbox backend (${sandbox.backendId}) and can’t be used on this server.`));
	}
	return backend;
}

/** A new sandbox on the connection, running, with its row. */
export function makeSandbox(data: {id: string; orgId: string; connectionId: string; name: string}): Promise<Result<SandboxRow, ApiError>> {
	return Do(async ($) => {
		const backend = $(await requireBackend());
		const ref = $(await backend.create({tenant: data.orgId, sandboxId: data.id}));
		const made = await createSandbox({...data, backendId: backend.id, backendRef: ref});
		if (made.isErr()) {
			// The row could not be written: the machine is not left behind.
			await backend.destroy(ref);
		}
		return $(made);
	});
}

/** The sandbox running: woken where it was asleep; as it is otherwise. */
export function wakeSandbox(sandbox: SandboxRow): Promise<Result<SandboxRow, ApiError>> {
	return Do(async ($) => {
		if (sandbox.state === 'running') {
			return sandbox;
		}
		const backend = $(await backendOf(sandbox));
		const ref = $(await backend.wake(sandbox.backendRef));
		$(await moveSandbox(sandbox.id, 'asleep', 'running', ref));
		return $(requirePresent($(await getSandbox(sandbox.connectionId, sandbox.id)), ApiErr.notFound('sandbox', sandbox.id)));
	});
}

/** The sandbox asleep: put to sleep where it was running; as it is otherwise. */
export function sleepSandbox(sandbox: SandboxRow): Promise<Result<SandboxRow, ApiError>> {
	return Do(async ($) => {
		if (sandbox.state === 'asleep') {
			return sandbox;
		}
		const backend = $(await backendOf(sandbox));
		const ref = $(await backend.sleep(sandbox.backendRef));
		$(await moveSandbox(sandbox.id, 'running', 'asleep', ref));
		return $(requirePresent($(await getSandbox(sandbox.connectionId, sandbox.id)), ApiErr.notFound('sandbox', sandbox.id)));
	});
}

/** The sandbox gone, its machine and its row; a machine the backend no longer knows is gone already. */
export function destroySandbox(sandbox: SandboxRow): Promise<Result<void, ApiError>> {
	return Do(async ($) => {
		const backend = $(await backendOf(sandbox));
		const destroyed = await backend.destroy(sandbox.backendRef);
		if (destroyed.isErr() && destroyed.error.kind !== 'not_found') {
			return $(destroyed);
		}
		$(await deleteSandbox(sandbox.id));
	});
}
