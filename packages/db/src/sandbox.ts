import {Err, type Result} from 'ts-results-es';

import {ApiErr, type ApiError, Do, wrapDb} from '@proxy/utils';

import {db} from '.';

// The catalog's id for sandboxes (@proxy/integrations), which this package doesn't import.
const SANDBOX_INTEGRATION_ID = 'sandbox';
import type {SandboxState} from '@prisma/client';

/**
 * Sandboxes (schema.prisma Sandbox): the computers agents asked for on a Sandboxes connection,
 * each kept as its backend's ref and its state as the api last set it, and held by one task at a
 * time. The api's native/sandbox module reads and writes them; the rules of holding and waking
 * are its, and every change of state here is one update fenced on the state it moves from, so
 * two calls moving a sandbox at once never both ask the backend.
 */

export type SandboxRow = {
	id: string;
	orgId: string;
	connectionId: string;
	name: string;
	state: SandboxState;
	backendId: string;
	backendRef: string;
	heldByTaskId: string | null;
	heldAt: Date | null;
	lastUsedAt: Date;
	createdAt: Date;
};

export type {SandboxState};

const sandboxSelect = {
	id: true,
	orgId: true,
	connectionId: true,
	name: true,
	state: true,
	backendId: true,
	backendRef: true,
	heldByTaskId: true,
	heldAt: true,
	lastUsedAt: true,
	createdAt: true,
} as const;

/** A connection's sandboxes, newest first. */
export function listSandboxes(connectionId: string): Promise<Result<SandboxRow[], ApiError>> {
	return wrapDb(() =>
		db.sandbox.findMany({
			where: {connectionId},
			select: sandboxSelect,
			orderBy: {createdAt: 'desc'},
		}),
	);
}

/** `Ok(null)` for no such sandbox on the connection. */
export function getSandbox(
	connectionId: string,
	sandboxId: string,
): Promise<Result<SandboxRow | null, ApiError>> {
	return wrapDb(() =>
		db.sandbox.findFirst({where: {connectionId, id: sandboxId}, select: sandboxSelect}),
	);
}

/** The sandbox's row, running and nobody's, with the id the backend was given for it. */
export function createSandbox(data: {
	id: string;
	orgId: string;
	connectionId: string;
	name: string;
	backendId: string;
	backendRef: string;
}): Promise<Result<SandboxRow, ApiError>> {
	return wrapDb(() =>
		db.sandbox.create({data: {...data, state: 'running'}, select: sandboxSelect}),
	);
}

/**
 * Moves the sandbox from `from` to `to`, with the backend's ref from now on; `Ok(false)` where it
 * was not in `from` any more, moved by another call meanwhile.
 */
export function moveSandbox(
	sandboxId: string,
	from: SandboxState,
	to: SandboxState,
	backendRef: string,
): Promise<Result<boolean, ApiError>> {
	return Do(async ($) => {
		const {count} = $(
			await wrapDb(() =>
				db.sandbox.updateMany({
					where: {id: sandboxId, state: from},
					data: {state: to, backendRef, lastUsedAt: new Date()},
				}),
			),
		);
		return count > 0;
	});
}

/** Notes a command run in the sandbox, for the sweeper and the list. */
export function touchSandbox(sandboxId: string): Promise<Result<void, ApiError>> {
	return wrapDb(async () => {
		await db.sandbox.updateMany({where: {id: sandboxId}, data: {lastUsedAt: new Date()}});
	});
}

/**
 * Takes the sandbox for a task: where no task holds it, or `takingOver` names the task it was
 * held by, which has ended; `Ok(false)` where another took it meanwhile.
 */
export function holdSandbox(
	sandboxId: string,
	taskId: string,
	takingOver: string | null,
): Promise<Result<boolean, ApiError>> {
	return Do(async ($) => {
		const {count} = $(
			await wrapDb(() =>
				db.sandbox.updateMany({
					where: {id: sandboxId, heldByTaskId: takingOver},
					data: {heldByTaskId: taskId, heldAt: new Date()},
				}),
			),
		);
		return count > 0;
	});
}

export function deleteSandbox(sandboxId: string): Promise<Result<void, ApiError>> {
	return Do(async ($) => {
		const {count} = $(await wrapDb(() => db.sandbox.deleteMany({where: {id: sandboxId}})));
		if (count === 0) {
			return $(Err(ApiErr.notFound('sandbox', sandboxId)));
		}
	});
}

/** The sandboxes running with nothing done in them since `before`, oldest first, for the sweeper. */
export function listIdleRunningSandboxes(
	before: Date,
	limit: number,
): Promise<Result<SandboxRow[], ApiError>> {
	return wrapDb(() =>
		db.sandbox.findMany({
			where: {state: 'running', lastUsedAt: {lt: before}},
			select: sandboxSelect,
			orderBy: {lastUsedAt: 'asc'},
			take: limit,
		}),
	);
}

/** What a task that holds a sandbox is, by its id in the organization: its title, and when it was active and finished. */
export function getHoldingTask(
	orgId: string,
	taskId: string,
): Promise<
	Result<
		{
			id: string;
			parentId: string | null;
			title: string;
			lastActiveAt: Date;
			finishedAt: Date | null;
		} | null,
		ApiError
	>
> {
	return wrapDb(() =>
		db.agentTask.findFirst({
			where: {id: taskId, orgId},
			select: {id: true, parentId: true, title: true, lastActiveAt: true, finishedAt: true},
		}),
	);
}

/**
 * The Sandboxes connections an organization and a member should have, made where missing: the
 * shared one, with `sharedDefaults`, and the member's own, with `ownDefaults`, each called by the
 * organization's name, as the vaults are. Made by nobody in particular, so only the
 * organization's owner changes the shared one. Once however many ask at once: the second finds
 * the first's.
 */
export async function createMissingSandboxConnections(data: {
	orgId: string;
	userId: string | null;
	sharedDefaults: string[];
	ownDefaults: string[];
}): Promise<Result<void, ApiError>> {
	const wanted: Array<{ownerUserId: string | null; defaults: string[]}> = [
		{ownerUserId: null, defaults: data.sharedDefaults},
		...(data.userId === null ? [] : [{ownerUserId: data.userId, defaults: data.ownDefaults}]),
	];
	return wrapDb(() =>
		db.$transaction(async (tx) => {
			const org = await tx.organization.findUnique({where: {id: data.orgId}, select: {name: true}});
			if (!org) {
				return;
			}
			for (const {ownerUserId, defaults} of wanted) {
				const found = await tx.connection.findFirst({
					where: {orgId: data.orgId, integrationId: SANDBOX_INTEGRATION_ID, ownerUserId},
					select: {id: true},
				});
				if (found) {
					continue;
				}
				await tx.connection.create({
					data: {
						orgId: data.orgId,
						ownerUserId,
						connectedById: data.userId,
						integrationId: SANDBOX_INTEGRATION_ID,
						account: org.name,
						defaults: {create: defaults.map((actionId) => ({actionId}))},
					},
				});
			}
		}),
	);
}
