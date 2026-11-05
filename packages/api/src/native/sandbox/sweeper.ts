import {listIdleRunningSandboxes} from '@proxy/db/sandbox';

import {sandboxBackend} from '../../backends/backends';
import {log, serializeError} from '../../observability/log';
import {sleepSandbox} from './machines';

/**
 * Puts to sleep the sandboxes running with nothing done in them for a while, a few at a time
 * every minute, so an agent that walked away from one stops costing a machine; its next command
 * wakes it. Each api instance sweeps, and each sleep is fenced on the row's state, so two never
 * ask the backend for one sandbox.
 */

const SWEEP_MS = 60_000;
const IDLE_MS = 30 * 60_000;
const BATCH = 20;

export async function sweepIdleSandboxes(now = new Date()): Promise<void> {
	const idle = await listIdleRunningSandboxes(new Date(now.getTime() - IDLE_MS), BATCH);
	if (idle.isErr()) {
		log.error('The sandbox sweeper could not list sandboxes', serializeError(idle.error));
		return;
	}
	for (const sandbox of idle.value) {
		const slept = await sleepSandbox(sandbox);
		if (slept.isErr()) {
			log.warn('A sandbox could not be put to sleep', {sandboxId: sandbox.id, ...serializeError(slept.error)});
		}
	}
}

/** Starts the sweeper, where the server has a sandbox backend. */
export async function startSandboxSweeper(): Promise<void> {
	if ((await sandboxBackend()) === null) {
		return;
	}
	setInterval(() => void sweepIdleSandboxes(), SWEEP_MS).unref();
}
