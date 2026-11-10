import type {Result} from 'ts-results-es';

import {type ApiError, Do, hasExperiment, type Experiment} from '@proxy/utils';
import {FILES_DEFAULT_ACTIONS, FILES_INTEGRATION_ID} from '@proxy/integrations';
import type {Viewer} from '@proxy/db/viewer';

import {blobBackend} from '../../backends/backends';

/**
 * The Files connections: a drive of each member's own, as their vault is, but made the first
 * time it could be used rather than with their membership, as their Sandboxes are, since Files
 * are offered where the organization has the experiment and the server a blob store, and a
 * connection made is kept. What agents may do with a new one by default is everything: nothing
 * done to a drive is lost, each write keeping the version before and the trash what was put in
 * it. A shared agent, which is no member's, has none.
 */

/** Whether Files are offered to the holder: the experiment on, and a blob store here. */
export async function filesOffered(holder: {experiments: Experiment[]}): Promise<boolean> {
	return hasExperiment(holder, 'files') && (await blobBackend()) !== null;
}

/** Makes the member's own Files connection where they have none; nothing for a shared agent, or where Files aren't offered. */
export function ensureFilesConnection(viewer: Viewer & {experiments: Experiment[]}): Promise<Result<void, ApiError>> {
	return Do(async ($) => {
		const {orgId, userId} = viewer;
		if (userId === null || !(await filesOffered(viewer))) {
			return;
		}
		// Read here rather than as the module loads, as the Sandboxes' is (native/sandbox/connections.ts):
		// the gate's tests mock each database module they reach, and reach this one only where Files
		// are offered.
		const {createMissingFilesConnection} = await import('@proxy/db/files');
		$(await createMissingFilesConnection({orgId, userId, integrationId: FILES_INTEGRATION_ID, defaults: FILES_DEFAULT_ACTIONS}));
	});
}
