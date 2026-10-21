import {Err, type Result} from 'ts-results-es';

import {ApiErr, type ApiError, Do, requirePresent} from '@proxy/utils';
import {getConnectionWithCredential, type ConnectionRow, type Viewer} from '@proxy/db/connection';
import {getMembership} from '@proxy/db/organization';

export type StoredConnectionRow = ConnectionRow & {credential: string | null};

/** A connection the viewer sees: not found for any other. */
export function requireConnection(viewer: Viewer, connectionId: string): Promise<Result<StoredConnectionRow, ApiError>> {
	return Do(async ($) => {
		return $(requirePresent($(await getConnectionWithCredential(viewer, connectionId)), ApiErr.notFound('connection', connectionId)));
	});
}

/**
 * Whether the viewer may change a connection they see: their own, or a shared one they connected
 * or whose organization they own. Anyone else in it uses a shared connection without changing it.
 */
export function manages(viewer: Viewer, row: ConnectionRow): Promise<Result<boolean, ApiError>> {
	return Do(async ($) => {
		if (row.ownerUserId !== null || row.connectedById === viewer.userId) {
			return true;
		}
		return $(await getMembership(viewer.userId, viewer.orgId))?.role === 'owner';
	});
}

/** A connection the viewer may change (`manages`); forbidden for a shared one they only use. */
export function requireManaged(viewer: Viewer, connectionId: string): Promise<Result<StoredConnectionRow, ApiError>> {
	return Do(async ($) => {
		const row = $(await requireConnection(viewer, connectionId));
		if (!$(await manages(viewer, row))) {
			return $(Err(ApiErr.forbidden()));
		}
		return row;
	});
}
