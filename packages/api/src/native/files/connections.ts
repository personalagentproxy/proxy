import type {Result} from 'ts-results-es';

import {type ApiError, Do} from '@proxy/utils';
import {FILES_DEFAULT_ACTIONS, FILES_INTEGRATION_ID} from '@proxy/integrations';
import {createMissingFilesConnection} from '@proxy/db/files';
import type {Viewer} from '@proxy/db/viewer';

import {blobBackend} from '../../backends/backends';

/**
 * The Files connections: a drive of each member's own, as their vault is, but made the first
 * time it could be used rather than with their membership, as their Sandboxes are, since Files
 * are offered only where the server has a blob store, and a connection made is kept. What agents
 * may do with a new one by default is everything: nothing done to a drive is lost, each write
 * keeping the version before and the trash what was put in it. A shared agent, which is no
 * member's, has none.
 */

/** Whether Files are offered: the server has a blob store (FILES_DIR or FILES_S3_BUCKET). */
export async function filesOffered(): Promise<boolean> {
	return (await blobBackend()) !== null;
}

/** Makes the member's own Files connection where they have none; nothing for a shared agent, or where Files aren't offered. */
// TODO: once every server has a blob store, make each member's drive with their membership, as
// their vault is (orgs/starter-connections.ts), and delete this and its calls in
// connections/route.ts, agent-side/tools.ts and native/files/chat.ts.
export function ensureFilesConnection(viewer: Viewer): Promise<Result<void, ApiError>> {
	return Do(async ($) => {
		const {orgId, userId} = viewer;
		if (userId === null || !(await filesOffered())) {
			return;
		}
		$(await createMissingFilesConnection({orgId, userId, integrationId: FILES_INTEGRATION_ID, defaults: FILES_DEFAULT_ACTIONS}));
	});
}
