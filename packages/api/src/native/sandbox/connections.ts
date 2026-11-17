import type {Result} from 'ts-results-es';

import {type ApiError, Do} from '@proxy/utils';
import type {Viewer} from '@proxy/db/viewer';

import {sandboxBackend} from '../../backends/backends';

/**
 * The Sandboxes connections: one of each member's own, as their vault is, but made the first time
 * it could be used rather than with their membership, since sandboxes are offered where the server
 * has a backend, and a connection made is kept. What agents may do with a new one by default: see
 * and use sandboxes, never delete them. A shared agent, which is no member's, has none.
 */

const OWN_DEFAULTS = ['read', 'run'];

/**
 * Makes the member's own Sandboxes connection where they have none; nothing for a shared agent,
 * or where the server has no sandbox backend.
 */
export function ensureSandboxConnection(viewer: Viewer): Promise<Result<void, ApiError>> {
	return Do(async ($) => {
		const {orgId, userId} = viewer;
		if (userId === null || (await sandboxBackend()) === null) {
			return;
		}
		// Read here rather than as the module loads, as host-check.ts reads the environment: the
		// gate's tests mock each database module they reach, and reach this one only where the
		// server has a sandbox backend.
		const {createMissingSandboxConnection} = await import('@proxy/db/sandbox');
		$(await createMissingSandboxConnection({orgId, userId, defaults: OWN_DEFAULTS}));
	});
}
