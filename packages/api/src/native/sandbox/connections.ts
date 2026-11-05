import type {Result} from 'ts-results-es';

import {type ApiError, Do, hasExperiment, type Experiment} from '@proxy/utils';
import type {Viewer} from '@proxy/db/viewer';

import {sandboxBackend} from '../../backends/backends';

/**
 * The Sandboxes connections: one shared by the organization and one of each member's own, as
 * the vaults are, but made the first time they could be used rather than with the organization,
 * since sandboxes are offered where the organization has the experiment and the server a
 * backend, and a connection made is kept. What agents may do with a new one by default: see and
 * use sandboxes, never delete them, on the member's own; nothing on the organization's, which
 * its owner turns on for the shared agents that should have it.
 */

const OWN_DEFAULTS = ['read', 'run'];
const SHARED_DEFAULTS: string[] = [];

/** Whether sandboxes are offered to the holder: the experiment on, and a backend here. */
export async function sandboxesOffered(holder: {experiments: Experiment[]}): Promise<boolean> {
	return hasExperiment(holder, 'sandboxes') && (await sandboxBackend()) !== null;
}

/**
 * Makes the Sandboxes connections the viewer should have and hasn't: the organization's shared
 * one, and the member's own where the viewer is a member; nothing where sandboxes aren't offered.
 */
export function ensureSandboxConnections(viewer: Viewer & {experiments: Experiment[]}): Promise<Result<void, ApiError>> {
	return Do(async ($) => {
		if (!(await sandboxesOffered(viewer))) {
			return;
		}
		// Read here rather than as the module loads, as host-check.ts reads the environment: the
		// gate's tests mock each database module they reach, and reach this one only where
		// sandboxes are offered.
		const {createMissingSandboxConnections} = await import('@proxy/db/sandbox');
		$(
			await createMissingSandboxConnections({
				orgId: viewer.orgId,
				userId: viewer.userId,
				sharedDefaults: SHARED_DEFAULTS,
				ownDefaults: OWN_DEFAULTS,
			}),
		);
	});
}
