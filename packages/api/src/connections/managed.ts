import {Err, type Result} from 'ts-results-es';

import {ApiErr, type ApiError, Do, requirePresent} from '@proxy/utils';
import {getConnectionWithCredential, type ConnectionRow} from '@proxy/db/connection';
import type {MemberViewer} from '@proxy/db/viewer';
import type {OrgRole} from '@proxy/db/organization';
import type {IntegrationId} from '@proxy/integrations';

import {manages as managesThing} from '../utils/manages';

export type StoredConnectionRow = ConnectionRow & {credential: string | null};

/** A member with their role, which says what they may change beside their own. */
export type ManagingViewer = MemberViewer & {role: OrgRole};

/** A connection the viewer sees: not found for any other. */
export function requireConnection(viewer: MemberViewer, connectionId: string): Promise<Result<StoredConnectionRow, ApiError>> {
	return Do(async ($) => {
		return $(requirePresent($(await getConnectionWithCredential(viewer, connectionId)), ApiErr.notFound('connection', connectionId)));
	});
}

/**
 * Whether the viewer may change a connection they see: their own, or a shared one they connected
 * or whose organization they own (utils/manages.ts). Anyone else in it uses a shared connection
 * without changing it.
 */
export function manages(viewer: ManagingViewer, row: ConnectionRow): boolean {
	return managesThing(viewer, {ownerUserId: row.ownerUserId, byId: row.connectedById});
}

/** A connection the viewer may change (`manages`); forbidden for a shared one they only use. */
export function requireManaged(viewer: ManagingViewer, connectionId: string): Promise<Result<StoredConnectionRow, ApiError>> {
	return Do(async ($) => {
		const row = $(await requireConnection(viewer, connectionId));
		if (!manages(viewer, row)) {
			return $(Err(ApiErr.forbidden()));
		}
		return row;
	});
}

/**
 * A connection of the integration the viewer may change (`requireManaged`); one of another
 * integration is `mismatch`, not found unless the route says otherwise.
 */
export function requireManagedOf(
	viewer: ManagingViewer,
	connectionId: string,
	integrationId: IntegrationId,
	mismatch: ApiError = ApiErr.notFound('connection', connectionId),
): Promise<Result<StoredConnectionRow, ApiError>> {
	return Do(async ($) => {
		const row = $(await requireManaged(viewer, connectionId));
		if (row.integrationId !== integrationId) {
			return $(Err(mismatch));
		}
		return row;
	});
}
